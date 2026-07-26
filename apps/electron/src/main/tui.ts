// Interface terminal de sunflower — portée sur la mise en page d'Ollama-Code
// (github.com/Tromset/Ollama-Code) et repeinte en tournesol.
//
// Ce qui structure l'écran, et pourquoi :
//
//  - Une BANNIÈRE écrite une fois, en brut : marque en fonte bloc, tournesol
//    pixel à côté, carte d'état dessous. Elle part dans le défilement et n'est
//    jamais redessinée — donc jamais repositionnée par erreur.
//  - Un LOG à colonne de rôle fixe (`you` / `sun` / `sys` / `run` / `err`,
//    trois caractères, toujours au même endroit). C'est ce qui fait qu'un flux
//    mêlant questions, réponses, outils et notes se parcourt d'un coup d'œil.
//  - Un BAS D'ÉCRAN persistant : une barre d'état (mode, modèle, effort,
//    contexte) collée au-dessus de la ligne de saisie. Les deux forment le
//    prompt readline, donc c'est readline qui les redessine, quand il le faut.
//
// Trois partis pris repris de l'original parce qu'ils sont la raison pour
// laquelle son rendu ne scintille pas :
//   1. pas d'écran alterné — le log vit dans le défilement normal du terminal ;
//   2. le flux vivant est BORNÉ (tailLines) : une réponse longue ne pousse
//      jamais le bas d'écran hors du terminal ;
//   3. AUCUN SPINNER. L'occupation se lit à « thinking… » dans la barre d'état,
//      redessinée sur événement. Rien ne tourne pendant qu'on ne fait rien —
//      c'est aussi la règle du budget always-on (voir CLAUDE.md).
//
// Zéro dépendance, ANSI fait main ; module sans electron (imports runtime :
// node:readline) donc testable en node pur. Sans TTY (sortie redirigée), tout
// retombe sur des lignes `[sunflower]` — le contrat historique des logs n'a
// pas bougé.
import { createInterface, type Interface } from "node:readline";
import type { StatePayload, SttStatus } from "../shared/state";
import type { ChatStatus } from "./ollama";
import type { QuestionSource } from "./state-machine";
import type { CodeEvent, CodeMode, CodePermission } from "../shared/code";
import type { Effort } from "../shared/effort";
import { formatDeadline } from "../shared/effort";
import { FIELD, POSES } from "../shared/sunflower-pixels";
import { pixelArtLines } from "./tui-pixel";
import {
  ROLES,
  ROLE_WIDTH,
  SUBTITLE,
  WORDMARK,
  WORDMARK_SPLIT,
  WORDMARK_SPLIT_WIDTH,
  WORDMARK_WIDTH,
  type LogRole,
} from "./tui-theme";
import {
  box,
  createInk,
  padVisible,
  sideBySide,
  supportsTrueColor,
  tailLines,
  truncVisible,
  visibleWidth,
  type Ink,
} from "./tui-ansi";

/** Modes du prompt : `ask` parle au compagnon d'écran, les autres à
 *  Sunflower-Code (mêmes noms que dans Ollama-Code). */
export type CliMode = "ask" | CodeMode;

export const CLI_MODES: readonly CliMode[] = [
  "ask",
  "code",
  "chat",
  "vision",
  "plan",
] as const;

export interface TuiStatusInfo {
  host: string;
  model: string;
  reachable: boolean;
  pulled: boolean;
  whisperModel: string;
  sttStatus: SttStatus;
  hotkeyAvailable: boolean;
  version: string;
  /** Dossier de travail de Sunflower-Code. */
  codeWorkdir: string;
  /** Niveau de permission de Sunflower-Code. */
  codePermission: CodePermission;
  /** Sunflower Work autorisé ? (opt-in du tray / de l'app Work) */
  workEnabled: boolean;
  /** Preset d'effort en vigueur. */
  effort: Effort;
  /** Plafond de temps par tâche, en minutes (0 = aucun). */
  effortDeadlineMin: number;
}

export interface SttInfo {
  status: SttStatus;
  progress?: number;
  error?: string;
}

/** Une ligne du picker de modèles (`/model` sans argument). */
export interface PickItem {
  /** Valeur rendue à l'appelant. */
  value: string;
  /** Colonne principale. */
  label: string;
  /** Colonne secondaire, en gris (taille, quantization…). */
  meta?: string;
  /** Marqué « ● current ». */
  current?: boolean;
}

export interface ReplHandlers {
  /** Question posée au compagnon d'écran (mode `ask`). false = refusée. */
  submit(question: string): boolean;
  /** Message adressé à Sunflower-Code (tous les autres modes). C'est LA
   *  fonction qui envoie tout ce qui est tapé au harnais de codage. */
  code(message: string): void;
  /** Réponse à une demande d'accord d'outil. `always` = accord permanent
   *  pour CETTE action exacte, le temps de la session. */
  approve(approved: boolean, always?: boolean): void;
  /** Commande slash : `/mode code` arrive en ("mode", "code"). */
  command(name: string, args: string): void;
  interrupt(): void;
  quit(): void;
  isBusy(): boolean;
}

export interface Tui {
  /** Bannière de démarrage : marque, tournesol pixel et carte d'état. */
  banner(info: TuiStatusInfo): void;
  /** Ligne d'état voix (téléchargement/chargement whisper), sur transition. */
  refreshStt(stt: SttInfo): void;
  /** Branché sur broadcast() : phases, erreurs, retour au prompt à idle. */
  state(payload: StatePayload): void;
  /** Question prête (la version tapée est déjà visible au prompt). */
  question(text: string, source: QuestionSource): void;
  /** Statut du chat (ex. chargement à froid du modèle). */
  chatStatus(status: ChatStatus): void;
  /** Token de réponse, streamé brut vers le terminal. */
  answerToken(text: string): void;
  /** Fin de réponse : ligne de durée. */
  answerDone(): void;
  /** Budget de contexte atteint : un tchat neuf démarre. */
  contextReset(tokens: number): void;
  /** Étape de guide annoncée (le prompt reste actif pendant un guide). */
  guideStep(index: number, total: number, text: string): void;
  /** Détail d'erreur — visible seulement avec SUNFLOWER_DEBUG=1. */
  sessionError(context: string, err: unknown): void;
  /** Ligne de diagnostic — visible seulement avec SUNFLOWER_DEBUG=1. */
  debug(line: string): void;
  /** Ligne libre, écrite proprement au-dessus du bas d'écran. */
  log(line: string): void;
  /** Ligne d'information (colonne `sys`). */
  notice(line: string): void;
  /** Ligne d'avertissement (clay). */
  warn(line: string): void;
  /** Ligne de succès (vert). */
  ok(line: string): void;
  /** Carte d'aide : toutes les commandes slash. */
  help(rows: readonly (readonly [string, string])[]): void;
  /** Carte d'état à la demande (`/status`). */
  status(info: TuiStatusInfo): void;
  /** Met à jour ce que la barre d'état affiche en permanence. */
  setStatus(info: TuiStatusInfo): void;
  /** Consommation de contexte montrée dans la barre d'état. */
  setUsage(used: number, max: number): void;
  /** Change le badge de mode du prompt. */
  setMode(mode: CliMode): void;
  /** Mode courant (l'app décide où router un message). */
  mode(): CliMode;
  /** Liste interactive en surimpression ; résout sur le choix, ou null. */
  pick(title: string, items: PickItem[]): Promise<string | null>;
  /** Vrai tant qu'une surimpression mange les touches. */
  overlayOpen(): boolean;
  /** Rend un événement de Sunflower-Code (tokens, outils, accords…). */
  codeEvent(ev: CodeEvent): void;
  /** Démarre le prompt de saisie (no-op sans TTY). */
  startRepl(handlers: ReplHandlers): void;
  /** Stoppe readline et restaure le curseur. */
  dispose(): void;
}

const CLEAR_LINE = "\r\x1b[2K";
/** Petite fleur de ponctuation, reprise du reste de l'app. */
const FLOWER = "✿";
/** Lignes de « pensée » gardées à l'écran quand le bloc est déplié. */
const THINKING_ROWS = 8;
/** Lignes réservées au bas d'écran et à la marge dans le calcul du flux. */
const CHROME_ROWS = 14;

export function createTui(streams?: {
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
}): Tui {
  const out = streams?.out ?? process.stdout;
  const input = streams?.input ?? process.stdin;
  const fancy = out.isTTY === true && process.env["NO_COLOR"] === undefined;
  const debug = process.env["SUNFLOWER_DEBUG"] === "1";
  const ink: Ink = createInk(fancy);
  const { yellow, orange, cream, green, red, dim, bold } = ink;

  let rl: Interface | null = null;
  let handlers: ReplHandlers | null = null;
  let disposed = false;
  /** Une session occupe le terminal : pas de prompt tant que vrai. */
  let busyUi = false;
  let lastIsland: StatePayload["island"] | null = null;
  let lastStt: SttStatus | null = null;
  /** Réponse en cours d'écriture brute (pas de retour ligne encore). */
  let streaming = false;
  /** Préfixe de rôle déjà écrit pour cette réponse. */
  let sawToken = false;
  /** Départ du chrono de réponse. */
  let t0 = 0;
  /** Tokens bufferisés en mode non-TTY, vidés à answerDone. */
  let pending = "";
  /** Mode courant du prompt. */
  let cliMode: CliMode = "ask";
  /** Un outil de Sunflower-Code attend un y/n/a. */
  let awaitingApproval = false;
  /** Sunflower-Code écrit sa réponse (préfixe déjà posé). */
  let codeStreaming = false;
  /** Le modèle « réfléchit » : c'est ça qui remplace le spinner. */
  let thinking = false;
  /** Texte de pensée du tour en cours, et son repli. */
  let thinkingText = "";
  let thinkingCollapsed = true;
  /** Dernier état connu, pour la barre d'état. */
  let statusInfo: TuiStatusInfo | null = null;
  let usedTokens = 0;
  let maxTokens = 0;
  /** Surimpression ouverte : elle avale toutes les touches. */
  let overlay: {
    render(): void;
    key(name: string, ctrl: boolean): void;
  } | null = null;

  const columns = (): number => (out.columns && out.columns > 0 ? out.columns : 80);
  const rows = (): number => (out.rows && out.rows > 0 ? out.rows : 24);

  // ---- Bas d'écran : barre d'état + ligne de saisie ---------------------
  // Les deux sont le prompt readline. C'est readline qui décide quand
  // redessiner, donc rien ici ne tourne en fond : la barre se rafraîchit
  // quand l'état change, pas à la seconde.
  const statusBar = (): string => {
    const info = statusInfo;
    const left = [
      bold(yellow("sunflower")),
      dim("·"),
      cream(cliMode),
      ...(info ? [dim("·"), info.model] : []),
      ...(info ? [dim("·"), dim(`effort ${info.effort}`)] : []),
      ...(thinking ? [dim("·"), yellow("thinking…")] : []),
    ].join(" ");
    if (maxTokens <= 0) return ` ${truncVisible(left, columns() - 2)}`;
    const pct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
    const paint = pct >= 75 ? red : pct >= 50 ? yellow : green;
    const right = `${dim("ctx ")}${paint(usedTokens.toLocaleString("en-US"))}${dim(
      `/${maxTokens.toLocaleString("en-US")} (${pct}%)`,
    )}`;
    const gap = columns() - visibleWidth(left) - visibleWidth(right) - 2;
    return gap < 2
      ? ` ${truncVisible(left, columns() - 2)}`
      : ` ${left}${" ".repeat(gap)}${right}`;
  };

  const promptText = (): string => {
    if (!fancy) return "";
    if (awaitingApproval) {
      return `${orange("▸")} ${bold("run it?")} ${dim("[y/n/a]")} `;
    }
    return `${statusBar()}\n${bold(yellow("❯"))} `;
  };
  const refreshPrompt = () => {
    if (!rl) return;
    rl.setPrompt(promptText());
    if (!busyUi && !overlay) rl.prompt(true);
  };

  // ---- Écriture unique : préserve le bas d'écran et le flux -------------
  const showPrompt = () => {
    if (rl && !busyUi && !disposed && !overlay) rl.prompt(true);
  };
  const endStream = () => {
    if (streaming || codeStreaming) {
      out.write("\n");
      streaming = false;
      codeStreaming = false;
    }
  };
  const writeBlock = (lines: string[]) => {
    if (disposed || lines.length === 0) return;
    if (!fancy) {
      for (const line of lines) out.write(`${line}\n`);
      return;
    }
    if (streaming || codeStreaming) {
      out.write("\n");
      streaming = false;
      codeStreaming = false;
    } else {
      out.write(CLEAR_LINE);
    }
    out.write(`${lines.join("\n")}\n`);
    if (overlay) overlay.render();
    else showPrompt();
  };
  const writeLine = (line: string) => writeBlock([line]);

  /**
   * Une entrée de log : colonne de rôle rigide, puis le corps. Le corps est
   * réindenté sous la colonne, sinon une réponse de plusieurs lignes casse
   * l'alignement qui fait tout l'intérêt de la colonne.
   */
  const gutter = (role: LogRole): string => {
    const { label, color } = ROLES[role];
    return `${bold(ink.hex(color)(padVisible(label, ROLE_WIDTH)))}  `;
  };
  const logLine = (role: LogRole, text: string, meta?: string) => {
    if (!fancy) {
      out.write(`[sunflower] ${ROLES[role].label} ${meta ? `${meta} ` : ""}${text}\n`);
      return;
    }
    const indent = " ".repeat(ROLE_WIDTH + 2);
    const body = text.split("\n");
    const lines: string[] = [];
    if (meta) lines.push(`${gutter(role)}${dim(meta)}`);
    body.forEach((line, i) => {
      const head = i === 0 && !meta ? gutter(role) : indent;
      lines.push(`${head}${line}`);
    });
    writeBlock(lines);
  };

  // ---- Bannière --------------------------------------------------------
  const sttLabel = (status: SttStatus): string => {
    switch (status) {
      case "ready":
        return green("ready");
      case "loading":
        return "loading…";
      case "downloading":
        return "downloading…";
      case "absent":
        return red("model missing");
      case "error":
        return red("error");
      case "disabled":
        return red("unavailable");
    }
  };

  /** Les lignes de la carte d'état, partagées par la bannière et /status. */
  const statusLines = (info: TuiStatusInfo): string[] => {
    const kv = (key: string, value: string) =>
      `${dim(padVisible(key, 10))}${value}`;
    const modelNote = info.pulled
      ? green("ok")
      : red(`missing — /pull ${info.model}`);
    const ollamaNote = info.reachable
      ? green("ok")
      : red("not running — run: ollama serve");
    const hotkeyNote = info.hotkeyAvailable
      ? "hold ⌃⌥ and speak — or type below"
      : red("unavailable — grant accessibility in the panel");
    return [
      kv("model", `${cream(info.model)} ${dim("·")} ${modelNote}`),
      kv("ollama", `${info.host} ${dim("·")} ${ollamaNote}`),
      kv("voice", `${info.whisperModel} ${dim("·")} ${sttLabel(info.sttStatus)}`),
      kv("hotkey", hotkeyNote),
      kv(
        "effort",
        `${cream(info.effort)} ${dim("·")} ${dim(formatDeadline(info.effortDeadlineMin))}`,
      ),
      kv(
        "code",
        `${orange("sunflower-code")} ${dim("·")} ${info.codePermission} ${dim("·")} ${truncVisible(info.codeWorkdir, 34)}`,
      ),
      kv(
        "work",
        info.workEnabled
          ? `${green("on")} ${dim("· /work <chore> hands it over")}`
          : dim("off — enable it from the tray or the work app"),
      ),
    ];
  };

  /** Marque en fonte bloc, avec repli quand le terminal est étroit. */
  const wordmarkLines = (available: number): string[] => {
    if (available >= WORDMARK_WIDTH) return WORDMARK.map((l) => yellow(l));
    if (available >= WORDMARK_SPLIT_WIDTH) return WORDMARK_SPLIT.map((l) => yellow(l));
    return [bold(yellow("sunflower"))];
  };

  const banner = (info: TuiStatusInfo) => {
    statusInfo = info;
    if (!fancy) {
      out.write(
        `[sunflower] v${info.version} — ${info.model} @ ${info.host}` +
          ` (${info.reachable ? "reachable" : "unreachable"})\n`,
      );
      return;
    }
    // Le vrai tournesol pixel de l'app, en demi-blocs.
    const art = pixelArtLines(POSES.idle, {
      scaleX: 2,
      color: supportsTrueColor(),
    });
    const artWidth = Math.max(0, ...art.map((l) => visibleWidth(l)));
    const mark = wordmarkLines(columns() - artWidth - 6);
    const head = [...mark, "", `${dim(SUBTITLE)}   ${dim("·")}   ${dim(`v${info.version}`)}`];
    const pad = Math.max(0, Math.floor((head.length - art.length) / 2));
    const left = [...new Array<string>(pad).fill(""), ...art];
    out.write("\n");
    out.write(`${sideBySide(left, head, 3).join("\n")}\n\n`);
    out.write(`${box(statusLines(info), { ink, title: `${FLOWER} sunflower` }).join("\n")}\n`);
    out.write(
      `\n  ${dim("type a question, or")} ${yellow("/help")} ${dim("for the commands.")}\n\n`,
    );
    showPrompt();
  };

  const help = (rows_: readonly (readonly [string, string])[]) => {
    if (!fancy) {
      for (const [cmd, what] of rows_) out.write(`[sunflower] ${cmd} — ${what}\n`);
      return;
    }
    const width = Math.max(...rows_.map(([c]) => c.length));
    const lines = rows_.map(
      ([cmd, what]) => `${yellow(padVisible(cmd, width))}  ${dim(what)}`,
    );
    lines.push("");
    lines.push(dim(HINT));
    writeBlock(box(lines, { ink, title: `${FLOWER} commands` }));
  };

  const status = (info: TuiStatusInfo) => {
    statusInfo = info;
    if (!fancy) {
      out.write(`[sunflower] ${info.model} @ ${info.host}\n`);
      return;
    }
    writeBlock(
      box(statusLines(info), {
        ink,
        title: `${FLOWER} status`,
        badge: `mode ${cliMode}`,
      }),
    );
    refreshPrompt();
  };

  const HINT =
    "enter send · ctrl+c abort · ctrl+l thinking · ctrl+d quit · /help";

  // ---- Voix (whisper) --------------------------------------------------
  const refreshStt = (stt: SttInfo) => {
    if (!fancy || stt.status === lastStt) return;
    lastStt = stt.status;
    switch (stt.status) {
      case "downloading":
        logLine("sys", "voice — downloading the whisper model…");
        break;
      case "ready":
        logLine("sys", "voice ready — hold ⌃⌥ and speak");
        break;
      case "absent":
      case "error":
      case "disabled":
        logLine("err", `voice — ${stt.error ?? "unavailable"}`);
        break;
      case "loading":
        break; // transitoire, pas d'affichage
    }
  };

  // ---- Phases de session ----------------------------------------------
  const setThinking = (on: boolean) => {
    if (thinking === on) return;
    thinking = on;
    refreshPrompt();
  };

  const state = (payload: StatePayload) => {
    if (disposed) return;
    const island = payload.island;
    if (!fancy) {
      busyUi = island !== "idle";
      if (island === "error") {
        out.write(
          `[sunflower] error: ${payload.message ?? "something went wrong."}\n`,
        );
      }
      lastIsland = island;
      return;
    }
    if (island === lastIsland && island !== "error") return;
    lastIsland = island;
    switch (island) {
      case "idle":
        busyUi = false;
        setThinking(false);
        endStream();
        sawToken = false;
        showPrompt();
        break;
      case "listening":
        busyUi = true;
        setThinking(false);
        logLine("sys", "listening…");
        break;
      case "reading":
        busyUi = true;
        logLine("sys", "looking at your screen…");
        break;
      case "thinking":
        busyUi = true;
        t0 = Date.now();
        sawToken = false;
        pending = "";
        thinkingText = "";
        setThinking(true);
        break;
      case "answering":
        busyUi = true;
        setThinking(false); // le préfixe s'écrit au premier token
        break;
      case "acting":
        busyUi = true;
        break;
      case "guiding":
        // Prompt actif : taper une question annule le guide en cours.
        busyUi = false;
        setThinking(false);
        endStream();
        sawToken = false;
        showPrompt();
        break;
      case "error": {
        busyUi = true; // l'idle qui suit ramènera le prompt
        setThinking(false);
        logLine("err", payload.message ?? "something went wrong.");
        break;
      }
    }
  };

  // ---- Question et réponse --------------------------------------------
  const question = (text: string, source: QuestionSource) => {
    if (!fancy) {
      out.write(`[sunflower] question: ${text}\n`);
      return;
    }
    // Tapée : déjà visible, c'est la ligne échoée au prompt.
    if (source === "voice") logLine("you", text);
  };

  const chatStatus = (s: ChatStatus) => {
    if (s !== "loading-model") return;
    if (!fancy) {
      out.write("[sunflower] waking the model…\n");
      return;
    }
    logLine("sys", "waking the model…");
    setThinking(true);
  };

  const answerToken = (text: string) => {
    if (disposed) return;
    if (!fancy) {
      pending += text;
      return;
    }
    if (!sawToken) {
      sawToken = true;
      setThinking(false);
      out.write(CLEAR_LINE);
      out.write(gutter("sun"));
      streaming = true;
    }
    out.write(text);
  };

  const answerDone = () => {
    if (disposed) return;
    if (!fancy) {
      out.write(`[sunflower] answer: ${pending}\n`);
      pending = "";
      return;
    }
    setThinking(false);
    endStream();
    sawToken = false;
    flushThinking();
    const secs = t0 > 0 ? ((Date.now() - t0) / 1000).toFixed(1) : "?";
    writeBlock([dim(`${" ".repeat(ROLE_WIDTH + 2)}answered in ${secs}s`)]);
  };

  const contextReset = (tokens: number) => {
    const label = `${(tokens / 1000).toFixed(1)}k context tokens — starting a fresh chat`;
    if (!fancy) {
      out.write(`[sunflower] ${label}\n`);
      return;
    }
    usedTokens = 0;
    logLine("sys", label);
  };

  const guideStep = (index: number, total: number, text: string) => {
    if (disposed) return;
    logLine("sys", text, `step ${index}/${total}`);
  };

  const sessionError = (context: string, err: unknown) => {
    // Le message utilisateur arrive via l'état « error » ; ici, seulement
    // le détail technique, sur demande.
    if (!debug) return;
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    logLine("sys", `[debug] ${context}: ${detail}`);
  };

  const debugLine = (line: string) => {
    if (!debug) return;
    logLine("sys", `[debug] ${line}`);
  };

  // ---- Bloc « thinking » ------------------------------------------------
  // Replié par défaut (`[thinking · N lines]`), déplié à ctrl+L, et versé en
  // entier dans le log à la fin du tour dans les deux cas — le repli ne cache
  // rien, il évite juste qu'une réflexion de trente lignes noie la réponse.
  const noteThinking = (text: string) => {
    thinkingText += text;
    if (!fancy || thinkingCollapsed) return;
    const { lines, hidden } = tailLines(
      thinkingText,
      THINKING_ROWS,
      Math.max(20, columns() - ROLE_WIDTH - 2),
    );
    const shown = hidden > 0 ? [dim(`… (+${hidden} earlier lines)`), ...lines] : lines;
    writeBlock([dim("─ thinking ─"), ...shown.map((l) => dim(l))]);
  };
  const flushThinking = () => {
    if (!thinkingText.trim()) {
      thinkingText = "";
      return;
    }
    if (debug) {
      const count = thinkingText.split("\n").length;
      logLine("sys", `[thinking · ${count} line${count === 1 ? "" : "s"}]`);
    }
    thinkingText = "";
  };
  const toggleThinking = () => {
    thinkingCollapsed = !thinkingCollapsed;
    logLine(
      "sys",
      thinkingCollapsed ? "thinking block collapsed." : "thinking block expanded.",
    );
  };

  // ---- Surimpressions (picker de modèles) -------------------------------
  const pick = (title: string, items: PickItem[]): Promise<string | null> => {
    if (!fancy || !rl || items.length === 0 || overlay) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      let index = Math.max(
        0,
        items.findIndex((it) => it.current === true),
      );
      let painted = 0;

      const visibleRows = () => Math.max(3, Math.min(items.length, rows() - 10));

      const draw = () => {
        // Efface le rendu précédent, puis réécrit — le cadre reste en place
        // au lieu de défiler à chaque flèche.
        if (painted > 0) out.write(`\x1b[${painted}A`);
        const max = visibleRows();
        const start = Math.min(
          Math.max(0, index - Math.floor(max / 2)),
          Math.max(0, items.length - max),
        );
        const slice = items.slice(start, start + max);
        const above = start;
        const below = Math.max(0, items.length - (start + max));
        const lines: string[] = [];
        if (above > 0) lines.push(dim(`… ${above} more above`));
        for (const [i, item] of slice.entries()) {
          const selected = start + i === index;
          const head = selected ? bold(yellow("❯ ")) : "  ";
          const name = selected ? bold(yellow(item.label)) : cream(item.label);
          const meta = item.meta ? dim(`  ${item.meta}`) : "";
          const mark = item.current === true ? green(" ● current") : "";
          lines.push(truncVisible(`${head}${name}${meta}${mark}`, columns() - 4));
        }
        if (below > 0) lines.push(dim(`… ${below} more below`));
        lines.push("");
        lines.push(dim("↑/↓ or j/k move · enter select · esc cancel"));
        const framed = box(lines, { ink, title: `${FLOWER} ${title}` });
        out.write(
          `${CLEAR_LINE}${framed.map((l) => `${CLEAR_LINE}${l}`).join("\n")}\n`,
        );
        painted = framed.length;
      };

      const close = (value: string | null) => {
        overlay = null;
        out.write("\x1b[?25h");
        resolve(value);
        refreshPrompt();
      };

      overlay = {
        render: () => {
          painted = 0;
          draw();
        },
        key: (name, ctrl) => {
          if (name === "up" || name === "k") {
            index = (index - 1 + items.length) % items.length;
            draw();
          } else if (name === "down" || name === "j") {
            index = (index + 1) % items.length;
            draw();
          } else if (name === "return" || name === "enter") {
            close(items[index]?.value ?? null);
          } else if (name === "escape" || (ctrl && name === "c")) {
            close(null);
          }
        },
      };
      out.write("\x1b[?25l");
      draw();
    });
  };

  // ---- Sunflower-Code ---------------------------------------------------
  const codeEvent = (ev: CodeEvent) => {
    if (disposed) return;
    switch (ev.kind) {
      case "status":
        if (ev.status === "thinking") setThinking(true);
        else if (ev.status === "idle" || ev.status === "failed") setThinking(false);
        return;
      case "token":
        if (!fancy) {
          pending += ev.text;
          return;
        }
        if (!codeStreaming) {
          setThinking(false);
          out.write(CLEAR_LINE);
          out.write(gutter("sun"));
          codeStreaming = true;
        }
        out.write(ev.text);
        return;
      case "output": {
        // Sortie brute d'une commande : indentée sous la colonne `run`, sans
        // préfixe de rôle — c'est un terminal, pas une réponse.
        if (!fancy) {
          out.write(ev.text);
          return;
        }
        if (codeStreaming) {
          out.write("\n");
          codeStreaming = false;
        } else {
          out.write(CLEAR_LINE);
        }
        const indent = " ".repeat(ROLE_WIDTH + 2);
        const { lines, hidden } = tailLines(
          ev.text.replace(/\n$/, ""),
          Math.max(4, rows() - CHROME_ROWS),
          Math.max(20, columns() - indent.length),
        );
        const shown = hidden > 0 ? [`… (+${hidden} earlier lines)`, ...lines] : lines;
        out.write(shown.map((line) => (line ? `${indent}${dim(line)}` : "")).join("\n"));
        out.write("\n");
        showPrompt();
        return;
      }
      case "thinking":
        noteThinking(ev.text);
        return;
      case "answer":
        endStream();
        flushThinking();
        return;
      case "tool": {
        const call = ev.call;
        if (call.status === "running") {
          logLine("run", cream(call.display));
          return;
        }
        if (call.status === "done") {
          const head = (call.result ?? "").split("\n")[0] ?? "";
          const count = (call.result ?? "").split("\n").length;
          writeBlock([
            `${" ".repeat(ROLE_WIDTH + 2)}${green("✓")} ${dim(
              `${count > 1 ? `${count} lines · ` : ""}${truncVisible(head, 72)}`,
            )}${call.ms !== undefined ? dim(`  ${call.ms}ms`) : ""}`,
          ]);
          return;
        }
        writeBlock([
          `${" ".repeat(ROLE_WIDTH + 2)}${red("✗")} ${dim(call.note ?? call.status)}`,
        ]);
        return;
      }
      case "approval": {
        setThinking(false);
        awaitingApproval = true;
        writeBlock(
          box(
            [
              `${bold(orange(`Permission required: ${ev.call.name}`))}`,
              dim(ev.call.display),
              "",
              `${green("y")} ${dim("allow")} ${dim("·")} ${red("n")} ${dim("deny")} ${dim("·")} ${yellow("a")} ${dim("always allow this exact action")}`,
            ],
            { ink, title: `${FLOWER} approval` },
          ),
        );
        busyUi = false;
        refreshPrompt();
        return;
      }
      case "compacted":
        usedTokens = 0;
        logLine(
          "sys",
          `${(ev.tokens / 1000).toFixed(1)}k tokens — sunflower-code renewed its context`,
        );
        return;
      case "done":
        setThinking(false);
        endStream();
        flushThinking();
        if (!fancy && pending) {
          out.write(`[sunflower-code] ${pending}\n`);
          pending = "";
        }
        busyUi = false;
        showPrompt();
        return;
      case "error":
        setThinking(false);
        endStream();
        logLine("err", ev.message);
        busyUi = false;
        showPrompt();
        return;
    }
  };

  // ---- REPL ------------------------------------------------------------
  const onLine = (raw: string) => {
    const line = raw.trim();
    // Accord d'outil en attente : cette ligne est la réponse, rien d'autre.
    if (awaitingApproval) {
      awaitingApproval = false;
      const always = /^a(lways)?$/i.test(line);
      const ok = always || /^(y|yes|o|oui)$/i.test(line);
      refreshPrompt();
      logLine(
        "sys",
        always ? "allowed — and always, for this exact action." : ok ? "allowed." : "denied.",
      );
      busyUi = true;
      handlers?.approve(ok, always);
      return;
    }
    if (!line) {
      showPrompt();
      return;
    }
    if (line.startsWith("/")) {
      const space = line.indexOf(" ");
      const name = (space === -1 ? line.slice(1) : line.slice(1, space)).toLowerCase();
      const args = space === -1 ? "" : line.slice(space + 1).trim();
      handlers?.command(name, args);
      return;
    }
    if (cliMode === "ask") {
      if (!handlers?.submit(line)) {
        logLine("sys", "sunflower is busy — wait for the answer (ctrl+c interrupts).");
      }
      return;
    }
    busyUi = true;
    handlers?.code(line);
  };

  const startRepl = (h: ReplHandlers) => {
    if (disposed || rl) return;
    if (input.isTTY !== true || out.isTTY !== true) return;
    handlers = h;
    rl = createInterface({
      input,
      output: out,
      prompt: promptText(),
      terminal: true,
    });
    rl.on("line", onLine);
    // L'ordre compte, et il est repris d'Ollama-Code : une surimpression avale
    // tout ; ctrl+L bascule le bloc thinking MÊME en plein flux ; le reste
    // n'arrive qu'à un terminal libre.
    input.on("keypress", (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (disposed || !key) return;
      if (overlay) {
        overlay.key(key.name ?? "", key.ctrl === true);
        return;
      }
      if (key.ctrl === true && key.name === "l") {
        toggleThinking();
        return;
      }
    });
    rl.on("SIGINT", () => {
      if (overlay) {
        overlay.key("escape", false);
        return;
      }
      if (awaitingApproval) {
        awaitingApproval = false;
        refreshPrompt();
        logLine("sys", "denied.");
        handlers?.approve(false);
        return;
      }
      if (handlers?.isBusy()) {
        handlers.interrupt();
        logLine("sys", "aborted.");
        busyUi = false;
        showPrompt();
      } else {
        // Ctrl+C ne quitte jamais : c'est ctrl+D ou /quit qui ferment.
        logLine("sys", "nothing to abort — ctrl+d or /quit to leave.");
        showPrompt();
      }
    });
    // Ctrl+D : fermer proprement l'app, sauf si c'est nous qui fermons.
    rl.on("close", () => {
      if (!disposed) handlers?.quit();
    });
    showPrompt();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (fancy) {
      out.write(`${CLEAR_LINE}\x1b[?25h`);
      // Un petit champ de tournesols pour dire au revoir.
      const field = pixelArtLines(FIELD, { scaleX: 1, color: supportsTrueColor() });
      out.write(`${field.join("\n")}\n${dim("  see you.")}\n`);
    }
    rl?.close();
    rl = null;
  };

  return {
    banner,
    refreshStt,
    state,
    question,
    chatStatus,
    answerToken,
    answerDone,
    contextReset,
    guideStep,
    sessionError,
    debug: debugLine,
    log: (line: string) => writeLine(line),
    notice: (line: string) => logLine("sys", line),
    warn: (line: string) => logLine("err", orange(line)),
    ok: (line: string) => logLine("sys", green(line)),
    help,
    status,
    setStatus: (info) => {
      statusInfo = info;
      refreshPrompt();
    },
    setUsage: (used, max) => {
      usedTokens = used;
      maxTokens = max;
      refreshPrompt();
    },
    setMode: (next) => {
      cliMode = next;
      refreshPrompt();
      logLine(
        "sys",
        `mode ${bold(next)} ${dim(
          next === "ask"
            ? "— your questions go to the screen companion"
            : "— everything you type goes to sunflower-code",
        )}`,
      );
    },
    mode: () => cliMode,
    pick,
    overlayOpen: () => overlay !== null,
    codeEvent,
    startRepl,
    dispose,
  };
}

/** Exporté pour les tests de mise en page (largeur d'une carte rendue). */
export const __testing = { visibleWidth };
