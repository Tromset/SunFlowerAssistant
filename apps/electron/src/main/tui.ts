// Interface terminal de sunflower — la même carte, le même jaune et le même
// tournesol pixel que les fenêtres de l'app, rendus en caractères.
//
// Ce que ça contient :
//  - une bannière avec le VRAI tournesol pixel (demi-blocs 24 bits, voir
//    tui-pixel.ts) posé à côté d'une carte d'état encadrée,
//  - un prompt à badge de mode (`ask` pour le compagnon d'écran, `code` /
//    `plan` / `chat` / `vision` pour Sunflower-Code),
//  - des commandes slash (/help, /mode, /permission, /cd, /work, /status…),
//  - le rendu des appels d'outils de Sunflower-Code, accord y/n compris.
//
// Zéro dépendance, ANSI fait main ; module sans electron (imports runtime :
// node:readline) donc testable en node pur. Sans TTY (app packagée, sortie
// redirigée), tout retombe sur des lignes `[sunflower]` — le contrat
// historique des logs n'a pas bougé.
import { createInterface, type Interface } from "node:readline";
import type { StatePayload, SttStatus } from "../shared/state";
import type { ChatStatus } from "./ollama";
import type { QuestionSource } from "./state-machine";
import type { CodeEvent, CodeMode, CodePermission } from "../shared/code";
import { FIELD, POSES } from "../shared/sunflower-pixels";
import { pixelArtLines } from "./tui-pixel";
import {
  box,
  createInk,
  padVisible,
  sideBySide,
  supportsTrueColor,
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
}

export interface SttInfo {
  status: SttStatus;
  progress?: number;
  error?: string;
}

export interface ReplHandlers {
  /** Question posée au compagnon d'écran (mode `ask`). false = refusée. */
  submit(question: string): boolean;
  /** Message adressé à Sunflower-Code (tous les autres modes). C'est LA
   *  fonction qui envoie tout ce qui est tapé au harnais de codage. */
  code(message: string): void;
  /** Réponse à une demande d'accord d'outil (y/n). */
  approve(approved: boolean): void;
  /** Commande slash : `/mode code` arrive en ("mode", "code"). */
  command(name: string, args: string): void;
  interrupt(): void;
  quit(): void;
  isBusy(): boolean;
}

export interface Tui {
  /** Bannière de démarrage : tournesol pixel + carte d'état. */
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
  /** Ligne libre, écrite proprement au-dessus du prompt/spinner. */
  log(line: string): void;
  /** Ligne d'information encadrée par une petite fleur. */
  notice(line: string): void;
  /** Ligne d'avertissement (clay). */
  warn(line: string): void;
  /** Ligne de succès (vert). */
  ok(line: string): void;
  /** Carte d'aide : toutes les commandes slash. */
  help(): void;
  /** Carte d'état à la demande (`/status`). */
  status(info: TuiStatusInfo): void;
  /** Change le badge de mode du prompt. */
  setMode(mode: CliMode): void;
  /** Mode courant (l'app décide où router un message). */
  mode(): CliMode;
  /** Rend un événement de Sunflower-Code (tokens, outils, accords…). */
  codeEvent(ev: CodeEvent): void;
  /** Démarre le prompt de saisie (no-op sans TTY). */
  startRepl(handlers: ReplHandlers): void;
  /** Stoppe spinner + readline, restaure le curseur. */
  dispose(): void;
}

/** Spinner pixel : un carré qui fait le tour de sa cellule. */
const FRAMES = ["▘", "▝", "▗", "▖"];
const CLEAR_LINE = "\r\x1b[2K";
/** Petite fleur de ponctuation, reprise du reste de l'app. */
const FLOWER = "✿";

const SLASH_HELP: [string, string][] = [
  ["/help", "this card"],
  ["/mode <ask|code|chat|vision|plan>", "who answers what you type"],
  ["/permission <plan|normal|yolo>", "what sunflower-code may do on its own"],
  ["/cd <folder>", "sunflower-code's project folder"],
  ["/code", "open the sunflower-code app"],
  ["/model [name]", "show or switch the local model"],
  ["/status", "the status card again"],
  ["/clear", "forget the conversation and clear the screen"],
  ["/work <task>", "hand a computer chore to sunflower work"],
  ["/agents", "background coding agents of the panel"],
  ["/quit", "close sunflower"],
];

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
  /** Préfixe « sunflower — » déjà écrit pour cette réponse. */
  let sawToken = false;
  /** Départ du chrono de réponse (phase thinking). */
  let t0 = 0;
  /** Tokens bufferisés en mode non-TTY, vidés à answerDone. */
  let pending = "";
  /** Mode courant du prompt. */
  let cliMode: CliMode = "ask";
  /** Un outil de Sunflower-Code attend un y/n. */
  let awaitingApproval = false;
  /** Sunflower-Code écrit sa réponse (préfixe déjà posé). */
  let codeStreaming = false;

  // ---- Spinner ---------------------------------------------------------
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerLabel = "";
  let spinnerStart = 0;
  let frameIdx = 0;

  const renderSpinner = () => {
    const frame = FRAMES[frameIdx % FRAMES.length] ?? "▘";
    frameIdx++;
    const secs = ((Date.now() - spinnerStart) / 1000).toFixed(1);
    out.write(`${CLEAR_LINE}${yellow(frame)} ${spinnerLabel} ${dim(`${secs}s`)}`);
  };
  const startSpinner = (label: string) => {
    spinnerLabel = label;
    if (!fancy || spinnerTimer) return;
    spinnerStart = Date.now();
    out.write("\x1b[?25l"); // cacher le curseur
    spinnerTimer = setInterval(renderSpinner, 120);
    renderSpinner();
  };
  const stopSpinner = () => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    out.write(`${CLEAR_LINE}\x1b[?25h`);
  };

  // ---- Prompt ----------------------------------------------------------
  const promptText = (): string => {
    if (awaitingApproval) return `${orange("▸")} ${bold("run it?")} ${dim("[y/N]")} `;
    const badge = ink.chip(` ${cliMode} `);
    return `${badge} ${yellow("❯")} `;
  };
  const refreshPrompt = () => {
    if (rl) rl.setPrompt(promptText());
  };

  // ---- Écriture unique : préserve spinner, prompt et stream ------------
  const showPrompt = () => {
    if (rl && !busyUi && !disposed) rl.prompt(true);
  };
  const endStream = () => {
    if (streaming || codeStreaming) {
      out.write("\n");
      streaming = false;
      codeStreaming = false;
    }
  };
  const writeLine = (line: string) => {
    if (disposed) return;
    if (!fancy) {
      out.write(`${line}\n`);
      return;
    }
    if (streaming || codeStreaming) {
      out.write("\n"); // termine proprement la ligne streamée
      streaming = false;
      codeStreaming = false;
    } else {
      out.write(CLEAR_LINE); // efface spinner ou ligne de prompt
    }
    out.write(`${line}\n`);
    if (spinnerTimer) renderSpinner();
    else showPrompt();
  };
  const writeBlock = (lines: string[]) => {
    if (lines.length === 0) return;
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
    if (spinnerTimer) renderSpinner();
    else showPrompt();
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
      : red(`missing — ollama pull ${info.model}`);
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

  const banner = (info: TuiStatusInfo) => {
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
    const card = box(statusLines(info), {
      ink,
      title: `${FLOWER} sunflower`,
      badge: `v${info.version}`,
    });
    // La fleur est centrée verticalement sur la carte.
    const pad = Math.max(0, Math.floor((card.length - art.length) / 2));
    const left = [...new Array<string>(pad).fill(""), ...art];
    out.write("\n");
    out.write(`${sideBySide(left, card, 3).join("\n")}\n`);
    out.write(
      `\n  ${dim("type a question, or")} ${yellow("/help")} ${dim("for the commands.")}\n\n`,
    );
    showPrompt();
  };

  const help = () => {
    if (!fancy) {
      for (const [cmd, what] of SLASH_HELP) out.write(`[sunflower] ${cmd} — ${what}\n`);
      return;
    }
    const width = Math.max(...SLASH_HELP.map(([c]) => c.length));
    const lines = SLASH_HELP.map(
      ([cmd, what]) => `${yellow(padVisible(cmd, width))}  ${dim(what)}`,
    );
    lines.push("");
    lines.push(
      dim("ctrl+c interrupts · ctrl+d quits · a bare message goes to the current mode"),
    );
    writeBlock(box(lines, { ink, title: `${FLOWER} commands` }));
  };

  const status = (info: TuiStatusInfo) => {
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
  };

  // ---- Voix (whisper) --------------------------------------------------
  const refreshStt = (stt: SttInfo) => {
    if (!fancy || stt.status === lastStt) return;
    lastStt = stt.status;
    switch (stt.status) {
      case "downloading":
        writeLine(`${orange("◐")} voice — downloading the whisper model…`);
        break;
      case "ready":
        writeLine(`${green("●")} voice ready — hold ⌃⌥ and speak`);
        break;
      case "absent":
      case "error":
      case "disabled":
        writeLine(`${red("✗")} voice — ${stt.error ?? "unavailable"}`);
        break;
      case "loading":
        break; // transitoire, pas d'affichage
    }
  };

  // ---- Phases de session ----------------------------------------------
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
        stopSpinner();
        endStream();
        sawToken = false;
        showPrompt();
        break;
      case "listening":
        busyUi = true;
        stopSpinner();
        writeLine(`${orange("●")} listening…`);
        break;
      case "reading":
        busyUi = true;
        writeLine(`${orange("◐")} looking at your screen…`);
        break;
      case "thinking":
        busyUi = true;
        t0 = Date.now();
        sawToken = false;
        pending = "";
        startSpinner("thinking…");
        break;
      case "answering":
        busyUi = true;
        stopSpinner(); // le préfixe s'écrit au premier token
        break;
      case "acting":
        busyUi = true;
        break;
      case "guiding":
        // Prompt actif : taper une question annule le guide en cours.
        busyUi = false;
        stopSpinner();
        endStream();
        sawToken = false;
        showPrompt();
        break;
      case "error": {
        busyUi = true; // l'idle qui suit ramènera le prompt
        stopSpinner();
        writeLine(`${red("✗")} ${payload.message ?? "something went wrong."}`);
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
    if (source === "voice") {
      writeLine(`${yellow("❯")} ${bold("you")} ${dim("—")} ${text}`);
    }
  };

  const chatStatus = (s: ChatStatus) => {
    if (s !== "loading-model") return;
    if (!fancy) {
      out.write("[sunflower] waking the model…\n");
      return;
    }
    spinnerLabel = "waking the model…";
    if (!spinnerTimer) startSpinner(spinnerLabel);
  };

  const answerToken = (text: string) => {
    if (disposed) return;
    if (!fancy) {
      pending += text;
      return;
    }
    if (!sawToken) {
      sawToken = true;
      stopSpinner();
      out.write(`${yellow(FLOWER)} ${yellow("sunflower")} ${dim("—")} `);
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
    stopSpinner(); // défensif : réponse sans aucun token affiché
    endStream();
    sawToken = false;
    const secs = t0 > 0 ? ((Date.now() - t0) / 1000).toFixed(1) : "?";
    writeLine(dim(`✓ answered in ${secs}s`));
  };

  const contextReset = (tokens: number) => {
    const label = `${(tokens / 1000).toFixed(1)}k context tokens — starting a fresh chat`;
    if (!fancy) {
      out.write(`[sunflower] ${label}\n`);
      return;
    }
    writeLine(`${yellow("✦")} ${dim(label)}`);
  };

  const guideStep = (index: number, total: number, text: string) => {
    if (disposed) return;
    if (!fancy) {
      out.write(`[sunflower] step ${index}/${total}: ${text}\n`);
      return;
    }
    writeLine(`${yellow("➤")} ${dim(`step ${index}/${total}`)} ${text}`);
  };

  const sessionError = (context: string, err: unknown) => {
    // Le message utilisateur arrive via l'état « error » ; ici, seulement
    // le détail technique, sur demande.
    if (!debug) return;
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    writeLine(dim(`[debug] ${context}: ${detail}`));
  };

  const debugLine = (line: string) => {
    // Diagnostic (pointage, normalisation des marqueurs…), sur demande.
    if (!debug) return;
    writeLine(dim(`[debug] ${line}`));
  };

  // ---- Sunflower-Code ---------------------------------------------------
  const TOOL_MARK = "▸";

  const codeEvent = (ev: CodeEvent) => {
    if (disposed) return;
    switch (ev.kind) {
      case "status":
        if (ev.status === "thinking") {
          if (!fancy) return;
          startSpinner("sunflower-code is thinking…");
        } else if (ev.status === "idle" || ev.status === "failed") {
          stopSpinner();
        }
        return;
      case "token":
        if (!fancy) {
          pending += ev.text;
          return;
        }
        if (!codeStreaming) {
          stopSpinner();
          out.write(`${orange(FLOWER)} ${orange("sunflower-code")} ${dim("—")} `);
          codeStreaming = true;
        }
        out.write(ev.text);
        return;
      case "output":
        // Sortie brute d'une commande : elle s'écrit telle quelle, sans le
        // préfixe du modèle — c'est un terminal, pas une réponse.
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
        stopSpinner();
        out.write(
          ev.text
            .split("\n")
            .map((line) => (line ? `    ${dim(line)}` : ""))
            .join("\n"),
        );
        if (!ev.text.endsWith("\n")) out.write("\n");
        return;
      case "thinking":
        if (debug) writeLine(dim(`[think] ${ev.text.slice(0, 200)}`));
        return;
      case "answer":
        endStream();
        return;
      case "tool": {
        const call = ev.call;
        if (call.status === "running") {
          writeLine(`  ${orange(TOOL_MARK)} ${cream(call.display)}`);
          return;
        }
        if (call.status === "done") {
          const head = (call.result ?? "").split("\n")[0] ?? "";
          const lines = (call.result ?? "").split("\n").length;
          writeLine(
            `    ${green("✓")} ${dim(
              `${lines > 1 ? `${lines} lines · ` : ""}${truncVisible(head, 72)}`,
            )}${call.ms !== undefined ? dim(`  ${call.ms}ms`) : ""}`,
          );
          return;
        }
        writeLine(`    ${red("✗")} ${dim(call.note ?? call.status)}`);
        return;
      }
      case "approval": {
        stopSpinner();
        awaitingApproval = true;
        refreshPrompt();
        writeBlock([
          `  ${orange(TOOL_MARK)} ${bold(ev.call.display)}`,
          `    ${dim("sunflower-code wants to run this. y to allow, anything else to deny.")}`,
        ]);
        busyUi = false;
        showPrompt();
        return;
      }
      case "compacted":
        writeLine(
          `${yellow("✦")} ${dim(
            `${(ev.tokens / 1000).toFixed(1)}k tokens — sunflower-code renewed its context`,
          )}`,
        );
        return;
      case "done":
        stopSpinner();
        endStream();
        if (!fancy && pending) {
          out.write(`[sunflower-code] ${pending}\n`);
          pending = "";
        }
        busyUi = false;
        showPrompt();
        return;
      case "error":
        stopSpinner();
        endStream();
        writeLine(`${red("✗")} ${ev.message}`);
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
      refreshPrompt();
      const ok = /^(y|yes|o|oui)$/i.test(line);
      writeLine(ok ? dim("  → allowed.") : dim("  → denied."));
      busyUi = true;
      handlers?.approve(ok);
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
      if (name === "help" || name === "?") {
        help();
        return;
      }
      handlers?.command(name, args);
      return;
    }
    if (cliMode === "ask") {
      if (!handlers?.submit(line)) {
        writeLine(
          dim("sunflower is busy — wait for the answer (ctrl+c interrupts)."),
        );
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
    rl.on("SIGINT", () => {
      if (awaitingApproval) {
        awaitingApproval = false;
        refreshPrompt();
        writeLine(dim("  → denied."));
        handlers?.approve(false);
        return;
      }
      if (handlers?.isBusy()) {
        handlers.interrupt();
        writeLine(dim("interrupted."));
        busyUi = false;
        showPrompt();
      } else {
        writeLine(dim("bye."));
        handlers?.quit();
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
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
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
    notice: (line: string) => writeLine(`${yellow(FLOWER)} ${line}`),
    warn: (line: string) => writeLine(`${orange("!")} ${line}`),
    ok: (line: string) => writeLine(`${green("✓")} ${line}`),
    help,
    status,
    setMode: (next) => {
      cliMode = next;
      refreshPrompt();
      writeLine(
        `${yellow(FLOWER)} mode ${bold(next)} ${dim(
          next === "ask"
            ? "— your questions go to the screen companion"
            : "— everything you type goes to sunflower-code",
        )}`,
      );
    },
    mode: () => cliMode,
    codeEvent,
    startRepl,
    dispose,
  };
}

/** Exporté pour les tests de mise en page (largeur d'une carte rendue). */
export const __testing = { visibleWidth };
