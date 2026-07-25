// Sunflower-Code — la boucle agentique, portée depuis Ollama-Code et branchée
// sur le CLI de sunflower. Un tour = un appel au modèle local ; s'il demande
// des outils, ils passent par la permission (permissions.ts), s'exécutent
// (tools.ts), et leur résultat repart au modèle. On recommence jusqu'à une
// réponse sans outil, ou jusqu'au plafond de tours.
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
// session est COMPACTÉE (résumé local déterministe, zéro appel modèle en plus)
// et repart d'une fenêtre neuve — c'est ce qui permet de coder longtemps avec
// un modèle 8B.
import { checkOllama, createThinkStripper, ollamaHost } from "../ollama";
import { denyReason, gateFor, toolsFor } from "./permissions";
import { TOOLS, ToolError, ollamaToolSpecs, toolProtocolHelp } from "./tools";
import {
  CODE_TOOLS,
  type CodeEvent,
  type CodeMessage,
  type CodeMode,
  type CodePermission,
  type CodeSessionInfo,
  type CodeSessionStatus,
  type CodeToolCall,
  type CodeToolName,
} from "../../shared/code";

// ---- Bornes --------------------------------------------------------------
/** Tours de modèle par message utilisateur. */
const MAX_TURNS = 24;
/** Appels d'outils servis dans un même tour. */
const MAX_CALLS_PER_TURN = 4;
/** Premier token : le chargement à froid d'un modèle local prend son temps. */
const FIRST_TOKEN_MS = 300_000;
/** Silence entre deux paquets streamés : au-delà, c'est une panne. */
const INTER_CHUNK_MS = 90_000;
/** Fenêtre de contexte demandée à Ollama. */
const NUM_CTX = 16_384;
const NUM_PREDICT = 2048;
/** Au-delà, la session se compacte et repart d'une fenêtre neuve. */
const COMPACT_AT_TOKENS = 12_000;
/** Résultat d'outil rendu au modèle (l'affichage en garde moins). */
const MAX_TOOL_RESULT = 20_000;
/** Résultat d'outil montré au CLI. */
const MAX_TOOL_DISPLAY = 1200;

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
    const res = await fetch(`${ollamaHost()}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { capabilities?: unknown };
      ok =
        Array.isArray(data.capabilities) &&
        data.capabilities.includes("tools");
    }
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
    arm(FIRST_TOKEN_MS);
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: true,
        think: false,
        keep_alive: "10m",
        options: { temperature: 0.2, num_ctx: NUM_CTX, num_predict: NUM_PREDICT },
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
   *  Un seul accord peut être en vol à la fois (un outil par tour). */
  approve(approved: boolean): void;
  /** Coupe le tour en vol ET la commande en cours. */
  interrupt(): void;
  /** Repart d'une conversation vierge (garde mode/permission/dossier). */
  clear(): void;
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
  let ctrl: AbortController | null = null;
  let disposed = false;
  /** Résolveur de l'accord en attente (un seul à la fois par construction). */
  let approvalWaiter: ((ok: boolean) => void) | null = null;

  const emit = (ev: CodeEvent) => {
    if (!disposed) deps.onEvent(ev);
  };

  const setStatus = (next: CodeSessionStatus) => {
    if (status === next) return;
    status = next;
    emit({ kind: "status", status: next });
  };

  /** Compactage : on garde le premier message utilisateur (l'intention) et un
   *  résumé déterministe de ce qui a été fait, puis on repart d'une fenêtre
   *  neuve. Aucun appel modèle supplémentaire — c'est ce qui rend le
   *  renouvellement instantané et fiable. */
  const compact = () => {
    const spent = tokens;
    const firstUser = visible.find((m) => m.role === "user");
    const toolLines = visible
      .filter((m) => m.role === "tool")
      .slice(-12)
      .map((m) => `- ${m.content.split("\n")[0] ?? ""}`);
    const lastAnswer = [...visible].reverse().find((m) => m.role === "assistant");
    const summary = [
      "Context was renewed to keep the model sharp. Here is what happened so far.",
      firstUser ? `Original request: ${firstUser.content.slice(0, 600)}` : "",
      toolLines.length > 0 ? `Tools already run:\n${toolLines.join("\n")}` : "",
      lastAnswer ? `Your last answer: ${lastAnswer.content.slice(0, 800)}` : "",
      "Continue from here. Re-read any file you are unsure about instead of guessing.",
    ]
      .filter(Boolean)
      .join("\n\n");
    messages = [{ role: "user", content: summary }];
    tokens = 0;
    turns = 0;
    emit({ kind: "compacted", tokens: spent });
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
    if (gate === "ask") {
      setStatus("awaiting-approval");
      emit({ kind: "approval", call });
      const approved = await new Promise<boolean>((resolve) => {
        const onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
        approvalWaiter = (ok) => {
          signal.removeEventListener("abort", onAbort);
          resolve(ok);
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
    try {
      const result = await def.run(args, {
        workdir,
        signal,
        // Sortie de commande : un canal à part, pour que le CLI ne la
        // maquille pas en prose du modèle.
        onOutput: (text) => emit({ kind: "output", text }),
      });
      call.status = "done";
      call.result = result.slice(0, MAX_TOOL_RESULT);
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
    if (mode === "vision" && deps.capture) {
      const shot = await deps.capture().catch(() => null);
      if (shot) userMessage.images = [shot.imageB64];
    }
    messages.push(userMessage);
    visible.push({ role: "user", content: message });

    let answer = "";
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (signal.aborted) throw new Error("interrupted");
      if (tokens >= COMPACT_AT_TOKENS) compact();
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
      emit({ kind: "answer", text: prose, turn, maxTurns: MAX_TURNS });

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
      message: `stopped after ${MAX_TURNS} turns without a final answer.`,
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
      try {
        await run(text);
      } catch (err) {
        const aborted = ctrl?.signal.aborted ?? false;
        if (aborted) {
          emit({ kind: "done", text: "" });
        } else {
          setStatus("failed");
          emit({
            kind: "error",
            message: err instanceof Error ? err.message : "something went wrong.",
          });
        }
      } finally {
        ctrl = null;
        approvalWaiter = null;
        setStatus("idle");
      }
    },
    approve(approved) {
      // Un seul accord en vol par construction (les outils s'exécutent l'un
      // après l'autre) : une réponse tardive tombe simplement dans le vide.
      if (!approvalWaiter) return;
      const resolve = approvalWaiter;
      approvalWaiter = null;
      resolve(approved);
    },
    interrupt() {
      approvalWaiter?.(false);
      approvalWaiter = null;
      ctrl?.abort();
    },
    clear() {
      messages = [];
      visible = [];
      turns = 0;
      tokens = 0;
    },
    setMode(next) {
      mode = next;
    },
    setPermission(next) {
      permission = next;
    },
    setWorkdir(dir) {
      workdir = dir;
      messages = [];
      visible = [];
      turns = 0;
      tokens = 0;
    },
    info: () => ({
      mode,
      permission,
      workdir,
      status,
      turns,
      tokens,
      messages: visible.length,
    }),
    history: () => [...visible],
    busy: () => ctrl !== null,
    dispose() {
      disposed = true;
      approvalWaiter?.(false);
      approvalWaiter = null;
      ctrl?.abort();
      ctrl = null;
    },
  };
}
