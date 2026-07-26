// Agents de code en arrière-plan (même famille de boucle qu'Ollama-Code) :
// une file de tâches, un agent à la fois, des tours itératifs contre Ollama
// avec un prompt de codage. Le modèle peut demander à LIRE des fichiers
// (lignes « READ: chemin ») puis termine par des blocs ```file:chemin
// contenant le contenu complet proposé. Le runner en extrait une proposition
// {path, before, after} — JAMAIS écrite sur disque ici : l'application est
// exclusivement déclenchée par decide(), fichier par fichier, depuis la revue.
//
// Opt-in au lancement (allowCommands), le modèle peut aussi PROPOSER une
// commande shell par tour (« RUN: commande »). Trois garde-fous, dans l'ordre :
// une liste noire non contournable (refus d'office, visible au transcript),
// puis un clic humain exécuter/refuser OBLIGATOIRE par commande (statut
// awaiting-command), puis un spawn confiné au dossier du run avec timeout.
// Chaque étape (tour, token, lecture, commande) est diffusée via onEvent pour
// que le panneau et le rond montrent le travail réel, pas un spinner figé.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { checkOllama, createThinkStripper, ollamaHost } from "../ollama";
import { getConfig } from "../config-store";
import { budgetFor, type SurfaceBudget } from "../../shared/effort";
import { blockedReason } from "../shell-guard";
import type {
  AgentCommandDecision,
  AgentCommandRecord,
  AgentDecision,
  AgentEvent,
  AgentEventKind,
  AgentFileChange,
  AgentRun,
  AgentRunSummary,
  AgentTranscriptEntry,
} from "../../shared/agents";

// ---- Garde-fous --------------------------------------------------------
const MAX_READS_PER_TURN = 4; // fichiers servis par tour
const MAX_READ_BYTES = 16_000; // au-delà, contenu tronqué
const MAX_PROPOSAL_FILES = 10; // fichiers max dans une proposition
const MAX_LISTING_ENTRIES = 150; // arborescence initiale
// Tours, contexte, plafond de génération et attente du premier token viennent
// du preset d'effort (shared/effort.ts) : « medium » redonne 8 / 16384 / 2048.
const budget = (): SurfaceBudget => budgetFor(getConfig().effort, "agents");
const INTER_CHUNK_TIMEOUT_MS = 60_000; // silence entre paquets streamés
const TOKEN_FLUSH_MS = 100; // regroupe les tokens avant l'IPC (pas 1 event/token)
const COMMAND_TIMEOUT_MS = 120_000; // par commande approuvée
const MAX_COMMAND_OUTPUT = 64_000; // sortie gardée sur le record (UI)
const MAX_COMMAND_FEEDBACK = 4_000; // queue de sortie renvoyée au modèle
const MAX_OUTPUT_EVENT = 2_000; // borne d'un paquet command-output IPC
// Contexte plus large que le tchat écran (8192) : les tours accumulent des
// fichiers. Le runner Ollama redémarre en changeant de num_ctx — acceptable
// pour un travail d'arrière-plan.

// Prompt inchangé quand l'exécution n'est pas autorisée : le comportement
// propose-only historique reste strictement identique.
const SYSTEM_PROMPT = [
  "You are sunflower's background coding agent. You run fully locally and work in turns on ONE task inside ONE project folder.",
  "You can NEVER touch the disk: you only propose changes, and a human reviews then accepts or denies each file.",
  "To inspect existing files before deciding, reply with ONLY read requests, one per line, nothing else:",
  "READ: relative/path/to/file",
  "When you know exactly what to change, reply with one short sentence explaining the change, followed by one fenced block PER FILE containing the COMPLETE new content of that file (never a fragment, never a diff):",
  "```file:relative/path/to/file",
  "...entire file content...",
  "```",
  "Rules: no shell commands, no tools, no markdown outside the formats above. Paths are relative to the project folder; never use .. or absolute paths. Keep the changes minimal and focused on the task. Never claim the changes are applied.",
].join("\n");

// Variante opt-in : même contrat, plus le protocole « RUN: … » (les petits
// modèles locaux ne font pas de function-calling fiable — protocole texte).
const SYSTEM_PROMPT_WITH_RUN = [
  "You are sunflower's background coding agent. You run fully locally and work in turns on ONE task inside ONE project folder.",
  "You can NEVER touch the disk yourself: you only propose changes, and a human reviews then accepts or denies each file.",
  "To inspect existing files before deciding, reply with ONLY read requests, one per line, nothing else:",
  "READ: relative/path/to/file",
  "To run ONE shell command inside the project folder (tests, build, git diff…), reply with ONLY one line:",
  "RUN: command",
  "A human must approve every command before it runs (they may deny it), destructive commands are refused outright, and a command never runs outside the project folder. You then receive its exit code and output. Never assume a command ran until you see its result.",
  "When you know exactly what to change, reply with one short sentence explaining the change, followed by one fenced block PER FILE containing the COMPLETE new content of that file (never a fragment, never a diff):",
  "```file:relative/path/to/file",
  "...entire file content...",
  "```",
  "Rules: one action per reply (reads, one command, or a proposal), no markdown outside the formats above. Paths are relative to the project folder; never use .. or absolute paths. Keep the changes minimal and focused on the task. Never claim the changes are applied.",
].join("\n");

// ---- Parsing des réponses du modèle -------------------------------------
const FILE_BLOCK_RE =
  /```(?:[a-zA-Z0-9_+-]*[ \t]+)?file:[ \t]*([^\n`]+)\n([\s\S]*?)\n?```/g;
const READ_LINE_RE = /^READ:[ \t]*(.+?)[ \t]*$/gm;
const RUN_LINE_RE = /^RUN:[ \t]*(.+?)[ \t]*$/gm;

function parseFileBlocks(text: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const m of text.matchAll(FILE_BLOCK_RE)) {
    const p = (m[1] ?? "").trim().replace(/^\.\//, "");
    if (p) out.push({ path: p, content: m[2] ?? "" });
  }
  return out;
}

function parseReads(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(READ_LINE_RE)) {
    const p = (m[1] ?? "").trim().replace(/^\.\//, "");
    if (p) out.push(p);
  }
  return out.slice(0, MAX_READS_PER_TURN);
}

/** Première ligne « RUN: … » (une seule commande par tour) ; null sinon. */
function parseRun(text: string): string | null {
  RUN_LINE_RE.lastIndex = 0;
  const m = RUN_LINE_RE.exec(text);
  return m?.[1]?.trim() || null;
}

// ---- Sécurité chemins ----------------------------------------------------
/** Résout un chemin relatif DANS le dossier de travail ; null s'il s'en
 *  échappe (.. ou absolu) — même garde-fou qu'Ollama-Code. */
function safeResolve(workdir: string, rel: string): string | null {
  if (path.isAbsolute(rel)) return null;
  const abs = path.resolve(workdir, rel);
  const root = path.resolve(workdir);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "out"]);

/** Arborescence peu profonde pour ancrer le premier tour du modèle. */
function listFiles(workdir: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (entries.length >= MAX_LISTING_ENTRIES || depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= MAX_LISTING_ENTRIES) return;
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = path.relative(workdir, abs);
      if (st.isDirectory()) {
        entries.push(`${rel}/`);
        walk(abs, depth + 1);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(workdir, 0);
  return entries;
}

/** Sert les fichiers demandés par des lignes READ (lecture seule, bornée). */
function renderReads(workdir: string, reads: string[]): string {
  const parts: string[] = [];
  for (const rel of reads) {
    const abs = safeResolve(workdir, rel);
    if (!abs || path.basename(abs) === ".env") {
      parts.push(`READ ${rel}: refused (outside the project folder).`);
      continue;
    }
    if (!existsSync(abs)) {
      parts.push(`READ ${rel}: file not found.`);
      continue;
    }
    try {
      let content = readFileSync(abs, "utf8");
      let note = "";
      if (content.length > MAX_READ_BYTES) {
        content = content.slice(0, MAX_READ_BYTES);
        note = "\n[...truncated...]";
      }
      parts.push(`READ ${rel}:\n\`\`\`\n${content}${note}\n\`\`\``);
    } catch {
      parts.push(`READ ${rel}: unreadable.`);
    }
  }
  return parts.join("\n\n");
}

// ---- Appel Ollama (streamé : les tokens partiels remontent via onToken) ---
async function agentChat(
  messages: AgentTranscriptEntry[],
  signal: AbortSignal,
  onToken: (text: string) => void,
): Promise<string> {
  const status = await checkOllama();
  if (!status.reachable) {
    throw new Error("ollama can't be reached — run ollama serve.");
  }
  if (!status.pulled) {
    throw new Error(`model missing — ollama pull ${status.name}`);
  }
  const ctrl = new AbortController();
  // Premier paquet : budget large (chargement à froid) ; ensuite, un silence
  // prolongé entre paquets vaut panne — plus juste qu'un plafond global qui
  // tuerait une génération longue mais saine.
  let watchdog: NodeJS.Timeout | null = null;
  const arm = (ms: number) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => ctrl.abort(), ms);
  };
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const strip = createThinkStripper();
  let full = "";
  try {
    arm(budget().firstTokenMs);
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: status.name,
        stream: true,
        think: false,
        keep_alive: "10m",
        options: {
          temperature: 0.2,
          num_ctx: budget().numCtx,
          num_predict: budget().numPredict,
        },
        messages,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`ollama responded ${res.status}.`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(INTER_CHUNK_TIMEOUT_MS);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(`ollama: ${parsed.error}`);
        const content = strip(parsed.message?.content ?? "");
        if (content) {
          full += content;
          onToken(content);
        }
        if (parsed.done) return full.trim();
      }
    }
    return full.trim();
  } finally {
    if (watchdog) clearTimeout(watchdog);
    signal.removeEventListener("abort", onAbort);
  }
}

// ---- Exécution sandboxée d'une commande approuvée -------------------------
interface CommandResult {
  exitCode: number | null;
  errored: boolean;
  note?: string;
}

/** Lance la commande via le shell, cwd VERROUILLÉ sur run.workdir, timeout
 *  propre à la commande, stdout/stderr streamés vers onChunk et accumulés
 *  (bornés) sur le record. N'est appelée QU'après le clic d'approbation. */
function runCommand(
  workdir: string,
  record: AgentCommandRecord,
  signal: AbortSignal,
  onChunk: (text: string) => void,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(record.command, {
        cwd: workdir, // strict : jamais un autre dossier
        shell: true,
        env: process.env,
        // Groupe de processus dédié (POSIX) : le timeout tue aussi les
        // petits-enfants (npm → node → …), pas seulement le shell.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        errored: true,
        note: err instanceof Error ? err.message : "spawn failed",
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const killTree = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // déjà mort
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, COMMAND_TIMEOUT_MS);
    const onAbort = () => {
      cancelled = true;
      killTree();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const append = (buf: Buffer) => {
      const text = buf.toString("utf8");
      if (record.output.length < MAX_COMMAND_OUTPUT) {
        const room = MAX_COMMAND_OUTPUT - record.output.length;
        record.output +=
          text.length > room
            ? `${text.slice(0, room)}\n[...output truncated...]`
            : text;
      }
      onChunk(text.length > MAX_OUTPUT_EVENT ? text.slice(0, MAX_OUTPUT_EVENT) : text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) =>
      finish({ exitCode: null, errored: true, note: err.message }),
    );
    child.on("close", (code) =>
      finish({
        exitCode: code,
        errored: timedOut || cancelled,
        ...(timedOut
          ? { note: `killed after ${COMMAND_TIMEOUT_MS / 1000}s timeout` }
          : cancelled
            ? { note: "cancelled" }
            : {}),
      }),
    );
  });
}

// ---- Runner ---------------------------------------------------------------
export interface AgentRunnerDeps {
  /** Un agent a changé d'état (liste du panneau à rafraîchir). */
  onUpdate(run: AgentRun): void;
  /** Événement fin pendant un run (tour, token, lecture, commande…). */
  onEvent(ev: AgentEvent): void;
  /** Un agent vient de se terminer (notification + île si repos). */
  onFinished(run: AgentRun): void;
  /** La file est passée active ↔ inactive (pose du compagnon au repos). */
  onRunningChange(running: boolean): void;
}

export interface AgentRunner {
  /** Enfile une tâche ; l'exécution démarre dès que la file est libre.
   *  allowCommands (opt-in) autorise le protocole RUN: pour CE run —
   *  chaque commande attendra quand même un clic explicite. */
  start(task: string, workdir: string, allowCommands: boolean): AgentRunSummary;
  list(): AgentRunSummary[];
  get(id: string): AgentRun | null;
  /** Revue explicite : accept ⇒ écrit le fichier ; deny ⇒ rien. */
  decide(id: string, filePath: string, decision: AgentDecision): AgentRun | null;
  /** Clic exécuter/refuser sur LA commande en attente (awaiting-command). */
  decideCommand(
    id: string,
    commandId: number,
    decision: AgentCommandDecision,
  ): AgentRun | null;
  /** Annule un agent en file ou en cours (idempotent). */
  cancel(id: string): void;
  running(): boolean;
  dispose(): void;
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const runs: AgentRun[] = [];
  const aborts = new Map<string, AbortController>();
  /** Résolveur du clic exécuter/refuser en attente, par run. */
  const commandWaiters = new Map<string, (approved: boolean) => void>();
  let active: AgentRun | null = null;
  let wasRunning = false;
  let counter = 0;

  /** Historique borné : chaque run garde transcript + proposition complets,
   *  la mémoire grimperait sans limite sur une longue session. */
  const MAX_RUNS = 20;
  const trimHistory = () => {
    // runs est trié du plus récent au plus ancien (unshift) : on évince par
    // la fin, et UNIQUEMENT les runs terminés. Un run « awaiting-review »
    // porte une proposition jamais appliquée — l'évincer la perdrait sans
    // bruit ; mieux vaut un historique qui déborde qu'un travail effacé.
    for (let i = runs.length - 1; runs.length > MAX_RUNS && i >= 0; i--) {
      const r = runs[i];
      if (r && (r.status === "done" || r.status === "failed")) {
        runs.splice(i, 1);
      }
    }
  };

  const summary = (r: AgentRun): AgentRunSummary => ({
    id: r.id,
    task: r.task,
    workdir: r.workdir,
    status: r.status,
    createdAt: r.createdAt,
    ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    files: r.proposal.length,
    decided: Object.keys(r.decisions).length,
  });

  const setRunning = (running: boolean) => {
    if (running === wasRunning) return;
    wasRunning = running;
    deps.onRunningChange(running);
  };

  const pump = () => {
    if (active) return;
    const next = runs.find((r) => r.status === "queued");
    if (!next) {
      setRunning(false);
      return;
    }
    active = next;
    setRunning(true);
    void execute(next).finally(() => {
      active = null;
      pump();
    });
  };

  /** Gère UNE ligne RUN: — liste noire, attente du clic, exécution, retour
   *  au modèle. Toujours visible au transcript, jamais silencieux. */
  const handleCommand = async (
    run: AgentRun,
    command: string,
    turn: number,
    ctrl: AbortController,
    event: (kind: AgentEventKind, turn: number, detail: string, commandId?: number) => void,
    push: (entry: AgentTranscriptEntry) => void,
  ): Promise<void> => {
    const record: AgentCommandRecord = {
      id: run.commands.length,
      command,
      status: "pending",
      output: "",
    };
    // 1. Liste noire — refus d'office, sans même proposer le clic.
    const blocked = blockedReason(command);
    if (blocked) {
      record.status = "refused";
      record.note = blocked;
      run.commands.push(record);
      push({
        role: "user",
        content: `RUN ${command}: refused automatically (${blocked}). This kind of command is never allowed — continue without it.`,
      });
      event("command-refused", turn, command, record.id);
      deps.onUpdate(run);
      return;
    }
    // 2. Clic humain obligatoire — le run s'affiche « awaiting-command ».
    run.commands.push(record);
    run.status = "awaiting-command";
    event("command-request", turn, command, record.id);
    deps.onUpdate(run);
    const approved = await new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(false);
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
      commandWaiters.set(run.id, (ok) => {
        ctrl.signal.removeEventListener("abort", onAbort);
        resolve(ok);
      });
    });
    commandWaiters.delete(run.id);
    if (ctrl.signal.aborted) {
      // Run annulé pendant l'attente du clic : la commande n'a jamais tourné,
      // le record le dit clairement au lieu de rester « pending » à jamais.
      record.status = "denied";
      record.note = "run cancelled";
      throw new Error("cancelled");
    }
    run.status = "running";
    if (!approved) {
      record.status = "denied";
      push({
        role: "user",
        content: `RUN ${command}: denied by the user. Continue without running it.`,
      });
      event("command-denied", turn, command, record.id);
      deps.onUpdate(run);
      return;
    }
    // 3. Exécution confinée au dossier du run, sortie streamée.
    record.status = "running";
    event("command-start", turn, command, record.id);
    deps.onUpdate(run);
    const result = await runCommand(run.workdir, record, ctrl.signal, (chunk) =>
      event("command-output", turn, chunk, record.id),
    );
    if (ctrl.signal.aborted) throw new Error("cancelled");
    record.status = result.errored ? "error" : "done";
    record.exitCode = result.exitCode;
    if (result.note !== undefined) record.note = result.note;
    event(
      "command-end",
      turn,
      `${command} — exit ${result.exitCode ?? "?"}${result.note ? ` (${result.note})` : ""}`,
      record.id,
    );
    const tail =
      record.output.length > MAX_COMMAND_FEEDBACK
        ? `[...truncated...]\n${record.output.slice(-MAX_COMMAND_FEEDBACK)}`
        : record.output;
    push({
      role: "user",
      content: `RUN ${command}: exited with code ${result.exitCode ?? "unknown"}${result.note ? ` (${result.note})` : ""}.\nOutput:\n\`\`\`\n${tail || "(no output)"}\n\`\`\``,
    });
    deps.onUpdate(run);
  };

  const execute = async (run: AgentRun): Promise<void> => {
    const ctrl = new AbortController();
    aborts.set(run.id, ctrl);
    const event = (
      kind: AgentEventKind,
      turn: number,
      detail: string,
      commandId?: number,
    ) =>
      deps.onEvent({
        runId: run.id,
        kind,
        turn,
        maxTurns: budget().maxTurns,
        detail,
        ...(commandId !== undefined ? { commandId } : {}),
      });
    run.status = "running";
    deps.onUpdate(run);
    event("status", 0, "running");
    try {
      const listing = listFiles(run.workdir).join("\n");
      const push = (entry: AgentTranscriptEntry) => run.transcript.push(entry);
      push({
        role: "system",
        content: run.allowCommands ? SYSTEM_PROMPT_WITH_RUN : SYSTEM_PROMPT,
      });
      push({
        role: "user",
        content: `Task: ${run.task}\n\nProject folder listing:\n${listing || "(empty folder)"}`,
      });
      let nudged = false;
      const maxTurns = budget().maxTurns;
      for (let turn = 0; turn < maxTurns; turn++) {
        const t = turn + 1;
        event("turn-start", t, "");
        deps.onUpdate(run);
        // Tokens partiels regroupés (TOKEN_FLUSH_MS) avant l'IPC.
        let tokenBuf = "";
        let tokenFlushAt = 0;
        const flushTokens = () => {
          if (!tokenBuf) return;
          event("model-token", t, tokenBuf);
          tokenBuf = "";
        };
        const answer = await agentChat(run.transcript, ctrl.signal, (text) => {
          tokenBuf += text;
          const now = Date.now();
          if (now - tokenFlushAt >= TOKEN_FLUSH_MS) {
            tokenFlushAt = now;
            flushTokens();
          }
        });
        flushTokens();
        if (ctrl.signal.aborted) throw new Error("cancelled");
        push({ role: "assistant", content: answer });
        event("model-answer", t, answer.slice(0, 200));
        deps.onUpdate(run);
        const blocks = parseFileBlocks(answer);
        if (blocks.length > 0) {
          const proposal: AgentFileChange[] = [];
          for (const b of blocks.slice(0, MAX_PROPOSAL_FILES)) {
            const abs = safeResolve(run.workdir, b.path);
            if (!abs) continue; // chemin hors dossier : ignoré
            const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
            const after = b.content.endsWith("\n")
              ? b.content
              : `${b.content}\n`;
            proposal.push({ path: b.path, before, after });
          }
          if (proposal.length === 0) {
            run.status = "failed";
            run.error = "the model only proposed paths outside the folder.";
          } else {
            run.proposal = proposal;
            run.status = "awaiting-review";
            event("proposal", t, String(proposal.length));
          }
          return;
        }
        const reads = parseReads(answer);
        if (reads.length > 0) {
          push({ role: "user", content: renderReads(run.workdir, reads) });
          event("read", t, reads.join(", "));
          deps.onUpdate(run);
          continue;
        }
        // Protocole RUN: — uniquement quand la case était cochée au
        // lancement ; sinon le comportement historique reste identique.
        if (run.allowCommands) {
          const command = parseRun(answer);
          if (command) {
            await handleCommand(run, command, t, ctrl, event, push);
            continue;
          }
        }
        if (!nudged && turn < maxTurns - 1) {
          // Un seul rappel de format ; ensuite la réponse libre fait foi.
          nudged = true;
          push({
            role: "user",
            content: run.allowCommands
              ? "Reply ONLY with READ: lines to inspect files, one RUN: command line, or with ```file:path fenced blocks holding the complete proposed content."
              : "Reply ONLY with READ: lines to inspect files, or with ```file:path fenced blocks holding the complete proposed content.",
          });
          continue;
        }
        // Réponse libre assumée : rien à proposer (question, explication…).
        run.status = "done";
        return;
      }
      run.status = "failed";
      run.error = "turn limit reached without a proposal.";
    } catch (err) {
      run.status = "failed";
      run.error = ctrl.signal.aborted
        ? "cancelled."
        : err instanceof Error
          ? err.message
          : "something went wrong.";
    } finally {
      aborts.delete(run.id);
      commandWaiters.delete(run.id);
      run.finishedAt = Date.now();
      deps.onUpdate(run);
      event("status", 0, run.status);
      deps.onFinished(run);
    }
  };

  return {
    start(task, workdir, allowCommands) {
      const dir = path.resolve(workdir);
      const run: AgentRun = {
        id: `a${Date.now().toString(36)}-${++counter}`,
        task: task.trim(),
        workdir: dir,
        status: "queued",
        createdAt: Date.now(),
        allowCommands: Boolean(allowCommands),
        transcript: [],
        proposal: [],
        decisions: {},
        commands: [],
      };
      if (!run.task) {
        run.status = "failed";
        run.error = "empty task.";
        run.finishedAt = Date.now();
      } else if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        run.status = "failed";
        run.error = "folder not found.";
        run.finishedAt = Date.now();
      }
      runs.unshift(run);
      trimHistory();
      deps.onUpdate(run);
      pump();
      return summary(run);
    },
    list() {
      return runs.map(summary);
    },
    get(id) {
      return runs.find((r) => r.id === id) ?? null;
    },
    decide(id, filePath, decision) {
      const run = runs.find((r) => r.id === id);
      if (!run || run.status !== "awaiting-review") return run ?? null;
      const change = run.proposal.find((c) => c.path === filePath);
      if (!change || run.decisions[filePath]) return run;
      if (decision === "accepted") {
        // SEUL point d'écriture disque de tout le système d'agents.
        const abs = safeResolve(run.workdir, change.path);
        if (!abs) return run; // défensif : déjà filtré à la proposition
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, change.after);
      }
      run.decisions[filePath] = decision;
      if (Object.keys(run.decisions).length >= run.proposal.length) {
        run.status = "done";
      }
      deps.onUpdate(run);
      return run;
    },
    decideCommand(id, commandId, decision) {
      const run = runs.find((r) => r.id === id);
      if (!run || run.status !== "awaiting-command") return run ?? null;
      const record = run.commands.find((c) => c.id === commandId);
      if (!record || record.status !== "pending") return run;
      // Le record et le statut du run sont mis à jour par handleCommand,
      // au réveil de la promesse — ici on ne fait que trancher.
      commandWaiters.get(run.id)?.(decision === "approved");
      return run;
    },
    cancel(id) {
      const run = runs.find((r) => r.id === id);
      if (!run) return;
      if (run.status === "queued") {
        run.status = "failed";
        run.error = "cancelled.";
        run.finishedAt = Date.now();
        deps.onUpdate(run);
      } else if (run.status === "running" || run.status === "awaiting-command") {
        aborts.get(id)?.abort();
      }
    },
    running() {
      return active !== null;
    },
    dispose() {
      for (const ctrl of aborts.values()) ctrl.abort();
    },
  };
}
