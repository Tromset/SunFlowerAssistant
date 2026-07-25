// Registre des sessions Sunflower Work : la mémoire de ce que la fleur a
// fait, fait, et va faire. C'est ce que l'app Work affiche — liste latérale,
// terminal, appels d'outils, chatbox — et c'est le seul endroit qui écrit
// dans un WorkSession. Le runner passe par ces méthodes, jamais par les
// objets directement, pour qu'AUCUNE mutation n'échappe à la diffusion.
//
// Tout est en mémoire : un run de travail n'a pas de valeur après la fermeture
// de l'app, et rien de ce qui est vu à l'écran ne doit atterrir sur le disque.
import type {
  WorkChatMessage,
  WorkEvent,
  WorkLogLine,
  WorkSession,
  WorkSessionSummary,
  WorkStatus,
  WorkTerminal,
  WorkToolCall,
} from "../../shared/work";
import { WORK_ACTIVE_STATUSES } from "../../shared/work";

/** Historique borné : au-delà, les sessions TERMINÉES les plus anciennes
 *  sortent. Une session active n'est jamais évincée. */
const MAX_SESSIONS = 30;
/** Lignes de journal gardées par session (l'app Work en affiche la queue). */
const MAX_LOG_LINES = 500;
/** Appels d'outils gardés par session. */
const MAX_CALLS = 400;
/** Messages de chat gardés par session. */
const MAX_CHAT = 200;

export interface WorkStore {
  create(task: string): WorkSession;
  get(id: string): WorkSession | null;
  list(): WorkSessionSummary[];
  /** Sessions en file, de la plus ancienne à la plus récente. */
  queued(): WorkSession[];
  setStatus(id: string, status: WorkStatus, message?: string): void;
  log(id: string, level: WorkLogLine["level"], text: string): void;
  /** Ouvre une nouvelle fenêtre de contexte (« terminal » renouvelé). */
  openTerminal(id: string, handoff?: string): WorkTerminal | null;
  /** Comptabilise des tokens sur la fenêtre courante. */
  addTokens(id: string, tokens: number): void;
  /** Enregistre (ou met à jour) un appel d'outil ; rend l'enregistrement. */
  pushCall(
    id: string,
    call: Omit<WorkToolCall, "id" | "at">,
  ): WorkToolCall | null;
  updateCall(id: string, callId: number, patch: Partial<WorkToolCall>): void;
  chat(id: string, role: WorkChatMessage["role"], text: string): void;
  /** Messages utilisateur pas encore servis au modèle (vidés à la lecture). */
  drainGuidance(id: string): string[];
  /** Purge une session terminée. */
  remove(id: string): void;
  summary(session: WorkSession): WorkSessionSummary;
}

export function createWorkStore(
  onEvent: (ev: WorkEvent) => void,
): WorkStore {
  /** Du plus récent au plus ancien (unshift). */
  const sessions: WorkSession[] = [];
  /** Consignes de la chatbox en attente, par session. */
  const guidance = new Map<string, string[]>();
  let counter = 0;

  const find = (id: string): WorkSession | null =>
    sessions.find((s) => s.id === id) ?? null;

  const summary = (s: WorkSession): WorkSessionSummary => ({
    id: s.id,
    task: s.task,
    status: s.status,
    createdAt: s.createdAt,
    ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
    steps: s.steps,
    terminals: s.terminals.length,
    ...(s.message !== undefined ? { message: s.message } : {}),
  });

  const trim = () => {
    for (let i = sessions.length - 1; sessions.length > MAX_SESSIONS && i >= 0; i--) {
      const s = sessions[i];
      if (s && !WORK_ACTIVE_STATUSES.includes(s.status)) {
        sessions.splice(i, 1);
        guidance.delete(s.id);
        onEvent({ kind: "removed", sessionId: s.id });
      }
    }
  };

  const currentTerminal = (s: WorkSession): WorkTerminal | undefined =>
    s.terminals[s.terminals.length - 1];

  return {
    create(task) {
      const session: WorkSession = {
        id: `w${Date.now().toString(36)}-${++counter}`,
        task: task.trim(),
        status: "queued",
        createdAt: Date.now(),
        steps: 0,
        terminals: [],
        calls: [],
        log: [],
        chat: [],
      };
      sessions.unshift(session);
      trim();
      onEvent({ kind: "created", sessionId: session.id });
      return session;
    },
    get: find,
    list: () => sessions.map(summary),
    queued: () =>
      sessions.filter((s) => s.status === "queued").slice().reverse(),
    setStatus(id, status, message) {
      const s = find(id);
      if (!s || s.status === status) return;
      s.status = status;
      if (message !== undefined) s.message = message;
      if (status === "running" && s.startedAt === undefined) {
        s.startedAt = Date.now();
      }
      if (!WORK_ACTIVE_STATUSES.includes(status)) {
        s.finishedAt = Date.now();
        const term = currentTerminal(s);
        if (term && term.endedAt === undefined) term.endedAt = Date.now();
      }
      onEvent({
        kind: "status",
        sessionId: id,
        status,
        ...(message !== undefined ? { message } : {}),
      });
    },
    log(id, level, text) {
      const s = find(id);
      if (!s) return;
      const line: WorkLogLine = { at: Date.now(), level, text };
      s.log.push(line);
      if (s.log.length > MAX_LOG_LINES) s.log.splice(0, s.log.length - MAX_LOG_LINES);
      onEvent({ kind: "log", sessionId: id, line });
    },
    openTerminal(id, handoff) {
      const s = find(id);
      if (!s) return null;
      const previous = currentTerminal(s);
      if (previous) {
        previous.endedAt = Date.now();
        if (handoff !== undefined) previous.handoff = handoff;
      }
      const terminal: WorkTerminal = {
        index: s.terminals.length + 1,
        startedAt: Date.now(),
        tokens: 0,
        steps: 0,
      };
      s.terminals.push(terminal);
      onEvent({ kind: "terminal", sessionId: id, terminal });
      return terminal;
    },
    addTokens(id, tokens) {
      const s = find(id);
      const term = s ? currentTerminal(s) : undefined;
      if (term) term.tokens += Math.max(0, tokens);
    },
    pushCall(id, call) {
      const s = find(id);
      if (!s) return null;
      const record: WorkToolCall = { ...call, id: s.calls.length, at: Date.now() };
      s.calls.push(record);
      if (s.calls.length > MAX_CALLS) s.calls.splice(0, s.calls.length - MAX_CALLS);
      onEvent({ kind: "call", sessionId: id, call: record });
      return record;
    },
    updateCall(id, callId, patch) {
      const s = find(id);
      if (!s) return;
      const record = s.calls.find((c) => c.id === callId);
      if (!record) return;
      Object.assign(record, patch);
      if (record.status === "done") {
        s.steps++;
        const term = currentTerminal(s);
        if (term) term.steps++;
      }
      onEvent({ kind: "call", sessionId: id, call: record });
    },
    chat(id, role, text) {
      const s = find(id);
      if (!s) return;
      const message: WorkChatMessage = { at: Date.now(), role, text };
      s.chat.push(message);
      if (s.chat.length > MAX_CHAT) s.chat.splice(0, s.chat.length - MAX_CHAT);
      if (role === "user") {
        const queue = guidance.get(id) ?? [];
        queue.push(text);
        guidance.set(id, queue);
      }
      onEvent({ kind: "chat", sessionId: id, message });
    },
    drainGuidance(id) {
      const queue = guidance.get(id) ?? [];
      guidance.set(id, []);
      return queue;
    },
    remove(id) {
      const i = sessions.findIndex((s) => s.id === id);
      if (i === -1) return;
      sessions.splice(i, 1);
      guidance.delete(id);
      onEvent({ kind: "removed", sessionId: id });
    },
    summary,
  };
}
