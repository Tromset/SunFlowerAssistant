// Sunflower-Code — la boucle agentique, portée depuis Ollama-Code et branchée
// sur le CLI de sunflower. Un tour = un appel au modèle local ; s'il demande
// des outils, ils passent par la permission (gateFor, dans shared/code.ts),
// s'exécutent (tools.ts), et leur résultat repart au modèle. On recommence
// jusqu'à une réponse sans outil, ou jusqu'au plafond de tours.
//
// Deux dialectes d'appel d'outil, parce que les petits modèles locaux ne sont
// pas égaux devant le function-calling :
//   1. l'API `tools` native d'Ollama quand le modèle l'annonce (/api/show),
//   2. sinon un protocole texte — un bloc ```tool contenant du JSON — dont le
//      gabarit est décrit dans le prompt système.
// Les deux produisent le même CodeToolCall, donc la suite du code ne sait même
// pas lequel a servi.
//
// Le contexte se renouvelle tout seul : au-delà du budget de tokens, la
// session ouvre un TERMINAL neuf — le mot de Sunflower Work pour une fenêtre
// de contexte renouvelée (work/runner.ts, renewTerminal). Résumé local
// déterministe, zéro appel modèle en plus : c'est ce qui permet de coder
// longtemps avec un modèle 8B.
//
// Trois choses traversent la couture, et c'est tout l'intérêt : le PROMPT DE
// LA TÂCHE tel quel (image comprise), la passation cumulée des terminaux
// précédents, et les derniers échanges verbatim. Changer de terminal ne doit
// pas se voir depuis la tâche.
import { checkOllama, createThinkStripper, ollamaHost } from "../ollama";
import { getConfig } from "../config-store";
import { budgetFor, type SurfaceBudget } from "../../shared/effort";
import { showModel } from "../../../lib/ollama-api.cjs";
import { TOOLS, ToolError, ollamaToolSpecs, toolProtocolHelp } from "./tools";
import { diffLines, diffTally } from "../../shared/diff";
import {
  CODE_COMPACT_AT_TOKENS,
  CODE_TOOLS,
  denyReason,
  gateFor,
  toolsFor,
  type CodeEvent,
  type CodeFileChange,
  type CodeMessage,
  type CodeMode,
  type CodePermission,
  type CodeSessionInfo,
  type CodeSessionStatus,
  type CodeToolCall,
  type CodeToolName,
} from "../../shared/code";

// ---- Bornes --------------------------------------------------------------
// Les deux que l'app affiche en jauge vivent dans shared/code.ts, pour que le
// dénominateur montré soit LE plafond réel et pas une copie qui dérive.
const COMPACT_AT_TOKENS = CODE_COMPACT_AT_TOKENS;
/** Appels d'outils servis dans un même tour. */
const MAX_CALLS_PER_TURN = 4;
/** Silence entre deux paquets streamés : au-delà, c'est une panne. */
const INTER_CHUNK_MS = 90_000;
/** Tours, contexte, plafond de génération et attente du premier token
 *  viennent du preset d'effort (shared/effort.ts) : « medium » redonne les
 *  valeurs historiques (24 tours / 16384 / 2048 / 300 s). Relu à chaque tour,
 *  pour qu'un `/effort high` en pleine session prenne au tour suivant. */
const budget = (): SurfaceBudget => budgetFor(getConfig().effort, "code");
/** Résultat d'outil rendu au modèle (l'affichage en garde moins). */
const MAX_TOOL_RESULT = 20_000;
/** Résultat d'outil montré au CLI. */
const MAX_TOOL_DISPLAY = 1200;
/** Prompt de la tâche, réinjecté tel quel dans chaque terminal ouvert. Large :
 *  c'est la DERNIÈRE chose qu'on tronque. */
const MAX_TASK_CHARS = 4_000;
/** Passation d'un terminal au suivant. Cumulée, donc bornée. */
const MAX_HANDOFF_CHARS = 2_000;
/** Derniers échanges repris VERBATIM dans le terminal neuf — ce qu'un résumé
 *  ne peut pas rendre : les chemins exacts, les noms de symboles, ce que le
 *  modèle vient de lire. */
const HANDOFF_TAIL_MESSAGES = 4;
/** …chacun tronqué à ça, pour que la queue ne remplisse pas la fenêtre neuve. */
const MAX_TAIL_CHARS = 800;

const BASE_RULES = [
  "You are Sunflower-Code, the coding agent that lives inside sunflower. You run 100% locally against the user's own Ollama — no cloud, no telemetry.",
  "You work inside ONE project folder. Every path you use is relative to it; absolute paths and .. are refused.",
  "Work in small steps: look before you edit, edit the smallest thing that does the job, then say what you did in one or two plain sentences.",
  "Never claim you changed a file unless a tool actually reported it. Never invent file contents — read the file.",
  "No markdown headings, no emoji. Short answers.",
].join(" ");

const MODE_RULES: Record<CodeMode, string> = {
  code: "You have the full toolbox: read, write, edit, move, list, search and shell.",
  chat: "You have NO tools in this mode. Answer from the conversation alone, and say so if you would need to read a file.",
  vision:
    "Same toolbox as code mode. A screenshot of the user's screen is attached to their message — use it to understand what they are pointing at.",
  plan: "This is a READ-ONLY investigation. You may read, list and search, never write and never run commands. Finish with a numbered plan of the changes you would make.",
};

function systemPrompt(
  mode: CodeMode,
  permission: CodePermission,
  workdir: string,
  names: readonly CodeToolName[],
  native: boolean,
): string {
  const parts = [BASE_RULES, MODE_RULES[mode], `Project folder: ${workdir}`];
  if (names.length === 0) {
    parts.push("No tools are available in this mode.");
  } else if (native) {
    parts.push(
      `Available tools: ${names.join(", ")}. Call them through the tool interface, one step at a time.`,
    );
  } else {
    parts.push(
      [
        "To use a tool, reply with NOTHING but one fenced block per call:",
        "```tool",
        '{"name": "read_file", "args": {"path": "src/main.ts"}}',
        "```",
        "Never mix prose and a tool block in the same reply. When you are done, reply with prose only.",
        "Tools:",
        toolProtocolHelp(names),
      ].join("\n"),
    );
  }
  if (permission === "normal") {
    parts.push(
      "Writes and shell commands need the user's explicit approval; if one is denied, carry on without it.",
    );
  }
  return parts.join("\n\n");
}

// ---- Messages envoyés à Ollama -------------------------------------------
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_name?: string;
}

interface RawToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

/** Normalise les arguments d'un appel : Ollama rend un objet, le protocole
 *  texte une chaîne JSON, et certains modèles un objet aux valeurs mixtes. */
function normalizeArgs(raw: unknown): Record<string, string> {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    out[key] =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  }
  return out;
}

function isToolName(name: unknown): name is CodeToolName {
  return typeof name === "string" && (CODE_TOOLS as readonly string[]).includes(name);
}

/** Blocs ```tool du protocole texte → appels. Exporté pour les tests. */
export function parseTextToolCalls(
  text: string,
): { name: CodeToolName; args: Record<string, string> }[] {
  const out: { name: CodeToolName; args: Record<string, string> }[] = [];
  const re = /```(?:tool|json)?\s*\n([\s\S]*?)\n?```/g;
  for (const m of text.matchAll(re)) {
    const body = (m[1] ?? "").trim();
    if (!body.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as { name?: unknown; args?: unknown; arguments?: unknown };
    if (!isToolName(rec.name)) continue;
    out.push({ name: rec.name, args: normalizeArgs(rec.args ?? rec.arguments) });
  }
  return out;
}

/** Le texte hors blocs ```tool (ce que le modèle a dit « pour de vrai »). */
function stripToolBlocks(text: string): string {
  return text.replace(/```(?:tool|json)?\s*\n[\s\S]*?\n?```/g, "").trim();
}

// ---- Capacité `tools` du modèle ------------------------------------------
const toolSupport = new Map<string, boolean>();

async function supportsNativeTools(model: string): Promise<boolean> {
  const cached = toolSupport.get(model);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const shown = await showModel(ollamaHost(), model, 4000);
    ok = shown.capabilities.includes("tools");
  } catch {
    ok = false; // sans réponse claire, le protocole texte marche partout
  }
  toolSupport.set(model, ok);
  return ok;
}

// ---- Un tour de modèle (streamé) -----------------------------------------
interface TurnResult {
  text: string;
  calls: { name: CodeToolName; args: Record<string, string> }[];
  tokens: number;
}

async function modelTurn(
  model: string,
  messages: OllamaMessage[],
  tools: unknown[] | null,
  signal: AbortSignal,
  onToken: (text: string) => void,
): Promise<TurnResult> {
  const ctrl = new AbortController();
  let watchdog: NodeJS.Timeout | null = null;
  const arm = (ms: number) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => ctrl.abort(), ms);
  };
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const strip = createThinkStripper();
  let full = "";
  let tokens = 0;
  const calls: { name: CodeToolName; args: Record<string, string> }[] = [];
  try {
    arm(budget().firstTokenMs);
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: true,
        think: false,
        keep_alive: "10m",
        options: {
          temperature: 0.2,
          num_ctx: budget().numCtx,
          num_predict: budget().numPredict,
        },
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
    });
    if (res.status === 404) {
      throw new Error(`model missing — ollama pull ${model}`);
    }
    if (!res.ok || !res.body) throw new Error(`ollama responded ${res.status}.`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(INTER_CHUNK_MS);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: {
          message?: { content?: string; tool_calls?: RawToolCall[] };
          done?: boolean;
          error?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(`ollama: ${parsed.error}`);
        for (const raw of parsed.message?.tool_calls ?? []) {
          const name = raw.function?.name;
          if (isToolName(name)) {
            calls.push({ name, args: normalizeArgs(raw.function?.arguments) });
          }
        }
        const content = strip(parsed.message?.content ?? "");
        if (content) {
          full += content;
          onToken(content);
        }
        if (parsed.done) {
          tokens = (parsed.prompt_eval_count ?? 0) + (parsed.eval_count ?? 0);
        }
      }
    }
    return { text: full.trim(), calls, tokens };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    signal.removeEventListener("abort", onAbort);
  }
}

// ---- Session --------------------------------------------------------------
export interface CodeSessionDeps {
  /** Dossier de travail initial (généralement le cwd du terminal). */
  workdir: string;
  mode: CodeMode;
  permission: CodePermission;
  /** Diffusion vers le CLI (tokens, outils, accords à donner…). */
  onEvent(ev: CodeEvent): void;
  /** Mode vision : capture jointe au message utilisateur. Absente = pas de
   *  vision (le mode retombe alors sur le comportement de `code`). */
  capture?(): Promise<{ imageB64: string } | null>;
}

export interface CodeSession {
  /**
   * LE point d'entrée du CLI : tout ce que l'utilisateur tape part ici.
   * Résout quand la requête est finie (réponse rendue, outils compris).
   */
  send(message: string): Promise<void>;
  /** Réponse à l'événement `approval` en attente : exécuter ou refuser.
   *  Un seul accord peut être en vol à la fois (un outil par tour), mais deux
   *  surfaces peuvent y répondre : le terminal appelle sans `callId` (il
   *  répond à l'invite qu'il vient d'imprimer), l'app avec l'identifiant de
   *  l'appel, pour qu'un clic en retard ne tranche pas l'accord suivant. */
  approve(approved: boolean, callId?: number, always?: boolean): void;
  /** Coupe le tour en vol ET la commande en cours. */
  interrupt(): void;
  /** Repart d'une conversation vierge (garde mode/permission/dossier). */
  clear(): void;
  /** Glisse une note dans le contexte sans déclencher de tour (`/btw`). */
  note(text: string): void;
  /** Joint une image au PROCHAIN message (`/image <chemin>`). */
  attachImage(imageB64: string): void;
  /** Ouvre un terminal neuf tout de suite (`/compact`) : la tâche et la
   *  passation traversent, le reste tombe. Faux si rien à renouveler. */
  compact(): boolean;
  setMode(mode: CodeMode): void;
  setPermission(permission: CodePermission): void;
  /** Change de dossier de travail (vide la conversation : autre projet). */
  setWorkdir(dir: string): void;
  info(): CodeSessionInfo;
  /** Conversation affichable (système exclu). */
  history(): CodeMessage[];
  busy(): boolean;
  dispose(): void;
}

export function createCodeSession(deps: CodeSessionDeps): CodeSession {
  let workdir = deps.workdir;
  let mode = deps.mode;
  let permission = deps.permission;
  let status: CodeSessionStatus = "idle";
  let messages: OllamaMessage[] = [];
  let visible: CodeMessage[] = [];
  let turns = 0;
  let tokens = 0;
  let callCounter = 0;
  /** Actions exactes (leur `display`) approuvées pour toute la session par un
   *  « a » au prompt d'accord. Vidé par clear() et par un changement de
   *  permission ou de dossier — la règle ne survit pas au contexte qui l'a
   *  justifiée. */
  const alwaysAllowed = new Set<string>();
  /** Le message qui a lancé la tâche en cours — L'OBJET, pas une copie, pour
   *  que sa capture d'écran (mode vision) traverse avec lui. Réinjecté tel
   *  quel dans chaque terminal ouvert ; gardé après la fin de la requête, pour
   *  qu'un `/compact` à l'invite sache encore de quelle tâche il parle. */
  let taskMessage: OllamaMessage | null = null;
  /** Ce que les terminaux précédents lèguent au courant. Cumulé. */
  let handoff = "";
  /** Fenêtre de contexte courante, 1-based. */
  let terminal = 1;
  /** Où le terminal courant commence dans `visible`. La passation ne résume
   *  QUE la fenêtre qui se ferme : sans cette marque, chaque renouvellement
   *  recopierait les outils déjà résumés par le précédent, et la passation
   *  cumulée se remplirait de doublons au lieu d'histoire. */
  let windowStart = 0;
  /** Image jointe au PROCHAIN message (`/image <chemin>`). */
  let pendingImage: string | null = null;
  let ctrl: AbortController | null = null;
  let disposed = false;
  /** Accord en attente : un seul à la fois par construction, mais DEUX
   *  surfaces peuvent y répondre (le terminal et l'app dédiée). L'identité de
   *  l'appel voyage donc avec le résolveur, pour qu'un clic en retard sur un
   *  accord déjà tranché tombe dans le vide au lieu de trancher le suivant. */
  let approvalWaiter: {
    callId: number;
    resolve(ok: boolean, always?: boolean): void;
  } | null = null;

  const emit = (ev: CodeEvent) => {
    if (!disposed) deps.onEvent(ev);
  };

  const setStatus = (next: CodeSessionStatus) => {
    if (status === next) return;
    status = next;
    emit({ kind: "status", status: next });
  };

  /** Ferme la fenêtre de contexte courante et en ouvre une neuve, sans que la
   *  tâche s'en aperçoive. Aucun appel modèle supplémentaire — c'est ce qui
   *  rend le renouvellement instantané et fiable.
   *
   *  La fenêtre neuve est faite de trois morceaux, dans cet ordre :
   *    1. la passation — ce que les terminaux précédents ont fait, cumulé ;
   *    2. les derniers échanges VERBATIM, tronqués ;
   *    3. le prompt de la tâche, tel quel, en dernier.
   *
   *  La tâche est en dernier parce que c'est ce qu'un petit modèle local suit
   *  le mieux, et parce que c'est précisément ce que l'ancien compactage
   *  jetait : il repartait d'un résumé qui citait le PREMIER message de la
   *  session, donc la mauvaise requête dès la deuxième tâche. */
  const renewTerminal = () => {
    const spent = tokens;
    // -- La passation. Elle CUMULE (`(earlier) …`, comme work/runner.ts) :
    //    sans ça, le troisième terminal ne saurait plus rien du premier.
    const closing = visible.slice(windowStart);
    const toolLines = closing
      .filter((m) => m.role === "tool")
      .slice(-12)
      .map((m) => `- ${m.content.split("\n")[0] ?? ""}`);
    const lastAnswer = [...closing].reverse().find((m) => m.role === "assistant");
    handoff = [
      handoff ? `(earlier) ${handoff}` : "",
      toolLines.length > 0 ? `Tools already run:\n${toolLines.join("\n")}` : "",
      lastAnswer ? `Your last answer: ${lastAnswer.content.slice(0, 800)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(-MAX_HANDOFF_CHARS);

    // -- La queue verbatim. Le message de la tâche en est exclu : il est
    //    réempilé entier à la fin, avec son image. Les captures des autres
    //    messages tombent — une image périmée coûte cher et ne dit plus rien.
    const tail: OllamaMessage[] = messages
      .filter((m) => m !== taskMessage)
      .slice(-HANDOFF_TAIL_MESSAGES)
      .map((m) => ({
        role: m.role,
        content: m.content.slice(0, MAX_TAIL_CHARS),
        ...(m.tool_name !== undefined ? { tool_name: m.tool_name } : {}),
      }));
    // Un résultat d'outil en tête de fenêtre a perdu l'appel qui l'a produit.
    while (tail[0]?.role === "tool") tail.shift();

    terminal++;
    messages = [
      {
        role: "user",
        content: [
          `Context was renewed to keep you sharp: you are now in terminal ${terminal} of this task, with a fresh window.`,
          handoff ? `Earlier in this task (previous terminals):\n${handoff}` : "",
          "The last exchanges follow, then the task again — unchanged. Continue from there, and re-read any file you are unsure about instead of guessing.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...tail,
    ];
    if (taskMessage) {
      // La copie tronquée DEVIENT le message de la tâche : le renouvellement
      // suivant la reconnaît et la remet à la fin au lieu de la dupliquer.
      taskMessage = {
        ...taskMessage,
        content: taskMessage.content.slice(0, MAX_TASK_CHARS),
      };
      messages.push(taskMessage);
    }
    tokens = 0;
    turns = 0;
    windowStart = visible.length;
    emit({ kind: "compacted", tokens: spent, terminal });
  };

  /** Un appel d'outil, de la permission au résultat. */
  const runCall = async (
    name: CodeToolName,
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<CodeToolCall> => {
    const def = TOOLS[name];
    const call: CodeToolCall = {
      id: ++callCounter,
      name,
      args,
      display: def.display(args),
      status: "pending",
    };
    const gate = gateFor(permission, name);
    if (gate === "deny") {
      call.status = "refused";
      call.note = denyReason(permission, name);
      emit({ kind: "tool", call });
      return call;
    }
    // « toujours » ne généralise RIEN : la règle porte sur l'action exacte
    // (même outil, mêmes arguments). Autoriser `bash npm test` une fois pour
    // toutes n'autorise pas `bash`, et surtout pas `bash rm -rf`.
    if (gate === "ask" && alwaysAllowed.has(call.display)) {
      emit({ kind: "tool", call: { ...call, note: "always allowed" } });
    } else if (gate === "ask") {
      setStatus("awaiting-approval");
      emit({ kind: "approval", call });
      const approved = await new Promise<boolean>((resolve) => {
        const onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
        approvalWaiter = {
          callId: call.id,
          resolve: (ok, always) => {
            signal.removeEventListener("abort", onAbort);
            if (ok && always === true) alwaysAllowed.add(call.display);
            resolve(ok);
          },
        };
      });
      approvalWaiter = null;
      if (!approved) {
        call.status = "denied";
        call.note = signal.aborted ? "interrupted" : "you denied it";
        emit({ kind: "tool", call });
        return call;
      }
    }
    setStatus("working");
    call.status = "running";
    emit({ kind: "tool", call });
    const t0 = Date.now();
    const changes: CodeFileChange[] = [];
    try {
      const result = await def.run(args, {
        workdir,
        signal,
        // Sortie de commande : un canal à part, pour que le CLI ne la
        // maquille pas en prose du modèle.
        onOutput: (text) => emit({ kind: "output", text }),
        // Ce qui a réellement changé sur le disque. Seul le diff est gardé —
        // jamais le contenu des fichiers, qui n'a rien à faire dans une
        // transcription ni sur un canal IPC.
        onChange: (relPath, before, after) => {
          const diff = diffLines(before, after);
          changes.push({ path: relPath, ...diffTally(diff), diff });
        },
      });
      call.status = "done";
      call.result = result.slice(0, MAX_TOOL_RESULT);
      if (changes.length > 0) call.changes = changes;
    } catch (err) {
      call.status = "error";
      call.note =
        err instanceof ToolError
          ? err.message
          : err instanceof Error
            ? err.message
            : "the tool failed.";
    }
    call.ms = Date.now() - t0;
    emit({ kind: "tool", call });
    return call;
  };

  /** Ce que le modèle reçoit en retour d'un appel — succès comme refus. */
  const feedback = (call: CodeToolCall): string => {
    switch (call.status) {
      case "done":
        return `${call.name} ok:\n${call.result ?? ""}`;
      case "refused":
      case "denied":
        return `${call.name} was not run: ${call.note ?? "refused"}. Continue without it.`;
      default:
        return `${call.name} failed: ${call.note ?? "unknown error"}`;
    }
  };

  const run = async (message: string): Promise<void> => {
    const ollama = await checkOllama();
    if (!ollama.reachable) {
      throw new Error("ollama can't be reached — run ollama serve.");
    }
    if (!ollama.pulled) {
      throw new Error(`model missing — ollama pull ${ollama.name}`);
    }
    const model = ollama.name;
    const names = toolsFor(mode, permission);
    const native = names.length > 0 && (await supportsNativeTools(model));
    const specs = native ? ollamaToolSpecs(names) : null;
    const signal = ctrl!.signal;

    const userMessage: OllamaMessage = { role: "user", content: message };
    // Une image jointe à la main (`/image`) prime sur la capture d'écran :
    // c'est un choix explicite de l'utilisateur pour CE message.
    if (pendingImage) {
      userMessage.images = [pendingImage];
      pendingImage = null;
    } else if (mode === "vision" && deps.capture) {
      const shot = await deps.capture().catch(() => null);
      if (shot) userMessage.images = [shot.imageB64];
    }
    messages.push(userMessage);
    visible.push({ role: "user", content: message });
    // LE prompt de la tâche : à partir d'ici, tout terminal ouvert le remet
    // dans sa fenêtre. Posé avant la boucle, parce que le renouvellement peut
    // tomber dès le premier tour (budget déjà dépassé par la requête d'avant).
    taskMessage = userMessage;

    let answer = "";
    const maxTurns = budget().maxTurns;
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (signal.aborted) throw new Error("interrupted");
      if (tokens >= COMPACT_AT_TOKENS) renewTerminal();
      setStatus("thinking");
      const head: OllamaMessage[] = [
        {
          role: "system",
          content: systemPrompt(mode, permission, workdir, names, native),
        },
        ...messages,
      ];
      const result = await modelTurn(model, head, specs, signal, (text) =>
        emit({ kind: "token", text }),
      );
      if (signal.aborted) throw new Error("interrupted");
      turns++;
      tokens += result.tokens;

      // Protocole texte : les blocs ```tool comptent comme des appels et ne
      // doivent pas être rendus comme de la prose.
      const textCalls = native ? [] : parseTextToolCalls(result.text);
      const asked = [...result.calls, ...textCalls];
      const calls = asked.slice(0, MAX_CALLS_PER_TURN);
      const dropped = asked.length - calls.length;
      const prose = native ? result.text : stripToolBlocks(result.text);

      messages.push({ role: "assistant", content: result.text });
      if (prose) {
        visible.push({ role: "assistant", content: prose });
        answer = prose;
      }
      emit({ kind: "answer", text: prose, turn, maxTurns });

      if (calls.length === 0) {
        emit({ kind: "done", text: answer });
        return;
      }
      for (const { name, args } of calls) {
        if (signal.aborted) throw new Error("interrupted");
        const call = await runCall(name, args, signal);
        const text = feedback(call);
        messages.push({ role: "tool", content: text, tool_name: name });
        visible.push({
          role: "tool",
          content: `${call.display} — ${text.slice(0, MAX_TOOL_DISPLAY)}`,
        });
      }
      if (dropped > 0) {
        // Jamais de troncature muette : le modèle doit savoir que ses
        // derniers appels n'ont pas tourné, sinon il croira les avoir faits.
        const note = `${dropped} more tool call(s) in that reply were not run — ${MAX_CALLS_PER_TURN} per turn is the limit. Ask for them again, one turn at a time.`;
        messages.push({ role: "user", content: note });
        emit({ kind: "tool", call: {
          id: ++callCounter,
          name: calls[0]?.name ?? "read_file",
          args: {},
          display: `${dropped} extra call(s) skipped`,
          status: "refused",
          note: `only ${MAX_CALLS_PER_TURN} tool calls run per turn`,
        } });
      }
    }
    emit({
      kind: "error",
      message: `stopped after ${maxTurns} turns without a final answer.`,
    });
  };

  return {
    async send(message) {
      const text = message.trim();
      if (!text || disposed) return;
      if (ctrl) {
        emit({ kind: "error", message: "sunflower-code is already working." });
        return;
      }
      ctrl = new AbortController();
      // Plafond de temps par tâche (`/effort 20m`). Un seul timer, armé pour
      // CETTE requête et désarmé au retour : rien ne survit au tour.
      const deadlineMin = getConfig().effortDeadlineMin;
      let deadline: NodeJS.Timeout | null = null;
      let outOfTime = false;
      if (deadlineMin > 0) {
        const aborter = ctrl;
        deadline = setTimeout(
          () => {
            outOfTime = true;
            aborter.abort();
          },
          deadlineMin * 60_000,
        );
      }
      try {
        await run(text);
      } catch (err) {
        const aborted = ctrl?.signal.aborted ?? false;
        if (outOfTime) {
          emit({
            kind: "error",
            message: `stopped after ${deadlineMin}m — the /effort time cap. /effort off removes it.`,
          });
        } else if (aborted) {
          emit({ kind: "done", text: "" });
        } else {
          setStatus("failed");
          emit({
            kind: "error",
            message: err instanceof Error ? err.message : "something went wrong.",
          });
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        ctrl = null;
        approvalWaiter = null;
        setStatus("idle");
      }
    },
    note(text) {
      const trimmed = text.trim();
      if (!trimmed || disposed) return;
      // Rôle utilisateur, pas système : le prompt système est reconstruit à
      // chaque tour, une note qui s'y glisserait disparaîtrait aussitôt.
      messages.push({ role: "user", content: `Note from the user: ${trimmed}` });
      visible.push({ role: "user", content: `(note) ${trimmed}` });
    },
    attachImage(imageB64) {
      pendingImage = imageB64;
    },
    compact() {
      if (messages.length === 0) return false;
      renewTerminal();
      return true;
    },
    approve(approved, callId, always) {
      const waiter = approvalWaiter;
      if (!waiter) return;
      // Sans identifiant — le terminal, qui ne peut répondre qu'à l'invite
      // qu'il vient d'imprimer — on accepte. Avec, il doit désigner l'accord
      // en cours : un bouton cliqué trop tard ne tranche pas le suivant.
      if (callId !== undefined && callId !== waiter.callId) return;
      approvalWaiter = null;
      waiter.resolve(approved, always);
    },
    interrupt() {
      approvalWaiter?.resolve(false);
      approvalWaiter = null;
      ctrl?.abort();
    },
    clear() {
      alwaysAllowed.clear();
      pendingImage = null;
      messages = [];
      visible = [];
      turns = 0;
      tokens = 0;
      // Plus de tâche, donc plus rien à faire traverser : on repart du
      // terminal 1, sans passation héritée d'une conversation effacée.
      taskMessage = null;
      handoff = "";
      terminal = 1;
      windowStart = 0;
    },
    setMode(next) {
      mode = next;
    },
    setPermission(next) {
      permission = next;
      // Un accord « toujours » a été donné sous un régime de permission ; il
      // ne vaut plus rien sous un autre.
      alwaysAllowed.clear();
    },
    setWorkdir(dir) {
      workdir = dir;
      alwaysAllowed.clear();
      pendingImage = null;
      messages = [];
      visible = [];
      turns = 0;
      tokens = 0;
      // Autre projet : la tâche et la passation de l'ancien n'ont plus de
      // sens ici. Le compteur de terminaux repart avec la conversation.
      taskMessage = null;
      handoff = "";
      terminal = 1;
      windowStart = 0;
    },
    info: () => ({
      mode,
      permission,
      workdir,
      status,
      turns,
      tokens,
      messages: visible.length,
      maxTurns: budget().maxTurns,
      terminal,
    }),
    history: () => [...visible],
    busy: () => ctrl !== null,
    dispose() {
      disposed = true;
      approvalWaiter?.resolve(false);
      approvalWaiter = null;
      ctrl?.abort();
      ctrl = null;
    },
  };
}
