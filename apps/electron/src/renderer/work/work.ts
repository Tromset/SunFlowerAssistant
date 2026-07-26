// Sunflower Work — le poste de pilotage. Trois colonnes : les agents à
// gauche, l'activité du run sélectionné au centre (appels d'outils et
// terminal), la chatbox et les limites à droite.
//
// Le rendu suit deux règles :
//  - un événement ne redessine que ce qu'il touche (une ligne de terminal
//    s'ajoute, elle ne reconstruit pas la vue) ;
//  - le défilement reste collant tant que l'utilisateur est en bas, et se
//    relâche dès qu'il remonte pour lire.
import { ensureBridge } from "../shared/dev-stub";
import { POSES, pixelArtSvg } from "../../shared/sunflower-pixels";
import {
  WORK_ACTIVE_STATUSES,
  type WorkChatMessage,
  type WorkEvent,
  type WorkLogLine,
  type WorkOnUserInput,
  type WorkSession,
  type WorkSessionSummary,
  type WorkSettings,
  type WorkStatus,
  type WorkToolCall,
} from "../../shared/work";

ensureBridge();

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

$("title-icon").innerHTML = pixelArtSvg(POSES.idle, 16, 18);

const titleNote = $("title-note");
const enableWork = $<HTMLInputElement>("enable-work");
const newTask = $<HTMLTextAreaElement>("new-task");
const newRun = $<HTMLButtonElement>("new-run");
const newError = $("new-error");
const sessionList = $("session-list");
const sessionsEmpty = $("sessions-empty");
const detailTask = $("detail-task");
const detailStatus = $("detail-status");
const detailSteps = $("detail-steps");
const detailTerminals = $("detail-terminals");
const detailCancel = $<HTMLButtonElement>("detail-cancel");
const tabCalls = $("tab-calls");
const tabTerm = $("tab-term");
const viewCalls = $("view-calls");
const viewTerm = $("view-term");
const callsEl = $("calls");
const callsEmpty = $("calls-empty");
const chatEl = $("chat");
const chatText = $<HTMLTextAreaElement>("chat-text");
const chatSend = $<HTMLButtonElement>("chat-send");
const setIdle = $<HTMLInputElement>("set-idle");
const setBudget = $<HTMLInputElement>("set-budget");
const setSteps = $<HTMLInputElement>("set-steps");
const setOnInput = $<HTMLSelectElement>("set-on-input");

let sessions: WorkSessionSummary[] = [];
let selectedId: string | null = null;
let selected: WorkSession | null = null;
/** L'utilisateur a-t-il choisi une session à la main ? (sinon on suit le run
 *  actif automatiquement — c'est ce qu'on veut en ouvrant l'app.) */
let pinned = false;

const STATUS_BADGE: Record<WorkStatus, [string, string]> = {
  queued: ["off", "queued"],
  "waiting-idle": ["wait", "waiting for you to leave"],
  running: ["run", "running"],
  paused: ["wait", "paused — the mac is yours"],
  done: ["ok", "done"],
  aborted: ["off", "stopped"],
  failed: ["bad", "failed"],
};

const isActive = (s: WorkStatus): boolean => WORK_ACTIVE_STATUSES.includes(s);

function timeOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- Défilement collant ---------------------------------------------------
function nearBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 32;
}
const stick = new WeakMap<HTMLElement, boolean>();
for (const el of [viewCalls, viewTerm, chatEl]) {
  stick.set(el, true);
  el.addEventListener("scroll", () => stick.set(el, nearBottom(el)));
}
function keepBottom(el: HTMLElement): void {
  if (stick.get(el) !== false) el.scrollTop = el.scrollHeight;
}

// ---- Liste des agents -----------------------------------------------------
function renderSessions(): void {
  sessionsEmpty.hidden = sessions.length > 0;
  sessionList.textContent = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = `session${s.id === selectedId ? " selected" : ""}`;
    const task = document.createElement("span");
    task.className = "session-task";
    task.textContent = s.task;
    task.title = s.task;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const [cls, label] = STATUS_BADGE[s.status];
    const badge = document.createElement("span");
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    const steps = document.createElement("span");
    steps.className = "meta";
    steps.textContent = `${s.steps} step${s.steps === 1 ? "" : "s"}`;
    meta.append(badge, steps);
    row.append(task, meta);
    row.addEventListener("click", () => {
      pinned = true;
      void select(s.id);
    });
    sessionList.append(row);
  }
  const active = sessions.find((s) => isActive(s.status));
  titleNote.textContent = active
    ? `${STATUS_BADGE[active.status][1]} — ${active.task}`
    : "nothing running";
}

// ---- Détail ---------------------------------------------------------------
function callLine(call: WorkToolCall): HTMLElement {
  const row = document.createElement("div");
  row.className = `call ${call.status}`;
  row.dataset["call"] = String(call.id);
  const step = document.createElement("span");
  step.className = "call-step";
  step.textContent = String(call.step).padStart(2, "0");
  const body = document.createElement("span");
  body.className = "call-body";
  const action = document.createElement("span");
  action.className = "call-action";
  // Un glisser a deux bouts : les montrer tous les deux, sinon la ligne ment
  // sur ce qui vient de se passer.
  const pct = (x?: number, y?: number) =>
    x !== undefined && y !== undefined
      ? `${(x * 100).toFixed(0)}%, ${(y * 100).toFixed(0)}%`
      : "";
  const from = pct(call.x, call.y);
  const to = pct(call.x2, call.y2);
  const at = from ? (to ? ` (${from} → ${to})` : ` (${from})`) : "";
  const text = call.text ? ` "${call.text.slice(0, 60)}"` : "";
  const amount = call.amount !== undefined ? ` ×${call.amount}` : "";
  action.textContent = `${call.action}${at}${text}${amount}`;
  body.append(action);
  if (call.why) {
    const why = document.createElement("span");
    why.className = "call-why";
    why.textContent = call.why;
    body.append(why);
  }
  if (call.note) {
    const note = document.createElement("span");
    note.className = "call-note";
    note.textContent = call.note;
    body.append(note);
  }
  const time = document.createElement("span");
  time.className = "call-time";
  time.textContent = timeOf(call.at);
  row.append(step, body, time);
  return row;
}

function renderCalls(session: WorkSession): void {
  callsEl.textContent = "";
  callsEmpty.hidden = session.calls.length > 0;
  // Les gestes sont regroupés par fenêtre de contexte : on intercale une
  // règle « terminal N » à chaque renouvellement pour que le découpage soit
  // visible plutôt que deviné.
  let cursor = 0;
  for (const terminal of session.terminals) {
    const rule = document.createElement("div");
    rule.className = "terminal-rule";
    rule.textContent =
      session.terminals.length > 1
        ? `terminal ${terminal.index} · ${terminal.tokens} tokens`
        : `terminal 1 · ${terminal.tokens} tokens`;
    callsEl.append(rule);
    const until = terminal.endedAt ?? Number.POSITIVE_INFINITY;
    while (cursor < session.calls.length) {
      const call = session.calls[cursor];
      if (!call || call.at > until) break;
      callsEl.append(callLine(call));
      cursor++;
    }
  }
  // Défensif : un geste arrivé hors de toute fenêtre reste affiché.
  for (; cursor < session.calls.length; cursor++) {
    const call = session.calls[cursor];
    if (call) callsEl.append(callLine(call));
  }
  keepBottom(viewCalls);
}

function logLine(line: WorkLogLine): HTMLElement {
  const span = document.createElement("span");
  span.className = line.level;
  span.textContent = `${timeOf(line.at)}  ${line.text}\n`;
  return span;
}

function renderTerm(session: WorkSession): void {
  viewTerm.textContent = "";
  for (const line of session.log) viewTerm.append(logLine(line));
  keepBottom(viewTerm);
}

function chatBubble(message: WorkChatMessage): HTMLElement {
  const div = document.createElement("div");
  div.className = `msg ${message.role}`;
  div.textContent = message.text;
  div.title = timeOf(message.at);
  return div;
}

function renderChat(session: WorkSession): void {
  chatEl.textContent = "";
  for (const message of session.chat) chatEl.append(chatBubble(message));
  keepBottom(chatEl);
}

function renderDetail(session: WorkSession | null): void {
  selected = session;
  if (!session) {
    detailTask.textContent = "pick a run on the left";
    detailStatus.className = "badge off";
    detailStatus.textContent = "idle";
    detailSteps.textContent = "";
    detailTerminals.textContent = "";
    detailCancel.hidden = true;
    callsEl.textContent = "";
    callsEmpty.hidden = false;
    viewTerm.textContent = "";
    chatEl.textContent = "";
    chatText.disabled = true;
    chatSend.disabled = true;
    return;
  }
  detailTask.textContent = session.task;
  const [cls, label] = STATUS_BADGE[session.status];
  detailStatus.className = `badge ${cls}`;
  detailStatus.textContent = session.message
    ? `${label} — ${session.message}`
    : label;
  detailSteps.textContent = `${session.steps} step${session.steps === 1 ? "" : "s"}`;
  detailTerminals.textContent = `${session.terminals.length} terminal${
    session.terminals.length === 1 ? "" : "s"
  }`;
  detailCancel.hidden = !isActive(session.status);
  const live = isActive(session.status);
  chatText.disabled = !live;
  chatSend.disabled = !live;
  renderCalls(session);
  renderTerm(session);
  renderChat(session);
}

async function select(id: string | null): Promise<void> {
  selectedId = id;
  renderSessions();
  if (!id) {
    renderDetail(null);
    return;
  }
  const session = await window.sunflower.workGet(id);
  if (selectedId !== id) return; // sélection changée entre-temps
  renderDetail(session);
}

/** Sans épinglage, l'app suit le run actif — sinon la plus récente. */
function autoSelect(): void {
  if (pinned && selectedId && sessions.some((s) => s.id === selectedId)) return;
  const next = sessions.find((s) => isActive(s.status)) ?? sessions[0] ?? null;
  if (next?.id !== selectedId) void select(next?.id ?? null);
}

// ---- Onglets --------------------------------------------------------------
function showTab(term: boolean): void {
  tabCalls.classList.toggle("active", !term);
  tabTerm.classList.toggle("active", term);
  viewCalls.hidden = term;
  viewTerm.hidden = !term;
  keepBottom(term ? viewTerm : viewCalls);
}
tabCalls.addEventListener("click", () => showTab(false));
tabTerm.addEventListener("click", () => showTab(true));

// ---- Création -------------------------------------------------------------
function submitTask(): void {
  const task = newTask.value.trim();
  newError.hidden = true;
  if (!task) {
    newError.textContent = "describe the chore first.";
    newError.hidden = false;
    return;
  }
  if (!enableWork.checked) {
    newError.textContent =
      "sunflower work is off — flip the switch in the title bar first.";
    newError.hidden = false;
    return;
  }
  newRun.disabled = true;
  void window.sunflower
    .workStart(task)
    .then((summary) => {
      if (!summary) {
        newError.textContent =
          "refused — sunflower work needs macOS and the accessibility permission.";
        newError.hidden = false;
        return;
      }
      newTask.value = "";
      pinned = true;
      void select(summary.id);
    })
    .catch(() => {
      newError.textContent = "couldn't start the run.";
      newError.hidden = false;
    })
    .finally(() => {
      newRun.disabled = false;
    });
}
newRun.addEventListener("click", submitTask);
newTask.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitTask();
});

detailCancel.addEventListener("click", () => {
  if (selectedId) void window.sunflower.workCancel(selectedId);
});

// ---- Chat -----------------------------------------------------------------
function sendChat(): void {
  const text = chatText.value.trim();
  if (!text || !selectedId) return;
  chatText.value = "";
  void window.sunflower.workChat(selectedId, text);
}
chatSend.addEventListener("click", sendChat);
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ---- Réglages -------------------------------------------------------------
function renderSettings(settings: WorkSettings): void {
  enableWork.checked = settings.enabled;
  setIdle.value = String(settings.requiredIdleSec);
  setBudget.value = String(settings.budgetMin);
  setSteps.value = String(settings.maxSteps);
  setOnInput.value = settings.onUserInput;
}

function pushSettings(patch: Partial<WorkSettings>): void {
  void window.sunflower.workSettingsSet(patch).then(renderSettings);
}

enableWork.addEventListener("change", () =>
  pushSettings({ enabled: enableWork.checked }),
);
setIdle.addEventListener("change", () =>
  pushSettings({ requiredIdleSec: Number(setIdle.value) }),
);
setBudget.addEventListener("change", () =>
  pushSettings({ budgetMin: Number(setBudget.value) }),
);
setSteps.addEventListener("change", () =>
  pushSettings({ maxSteps: Number(setSteps.value) }),
);
setOnInput.addEventListener("change", () =>
  pushSettings({ onUserInput: setOnInput.value as WorkOnUserInput }),
);

// ---- Flux -----------------------------------------------------------------
window.sunflower.onWorkChanged((next) => {
  sessions = next;
  renderSessions();
  autoSelect();
  // Le résumé porte statut/étapes : rafraîchir l'en-tête sans tout relire.
  const summary = sessions.find((s) => s.id === selectedId);
  if (summary && selected) {
    selected.status = summary.status;
    selected.steps = summary.steps;
    if (summary.message !== undefined) selected.message = summary.message;
    renderDetail(selected);
  }
});

window.sunflower.onWorkEvent((ev: WorkEvent) => {
  if (ev.kind === "created" || ev.kind === "removed") return; // couvert par workChanged
  if (ev.sessionId !== selectedId || !selected) return;
  switch (ev.kind) {
    case "log":
      selected.log.push(ev.line);
      viewTerm.append(logLine(ev.line));
      keepBottom(viewTerm);
      return;
    case "chat":
      selected.chat.push(ev.message);
      chatEl.append(chatBubble(ev.message));
      keepBottom(chatEl);
      return;
    case "call": {
      const existing = selected.calls.find((c) => c.id === ev.call.id);
      if (existing) Object.assign(existing, ev.call);
      else selected.calls.push(ev.call);
      const row = callsEl.querySelector<HTMLElement>(
        `.call[data-call="${ev.call.id}"]`,
      );
      if (row) row.replaceWith(callLine(ev.call));
      else {
        callsEmpty.hidden = true;
        callsEl.append(callLine(ev.call));
      }
      keepBottom(viewCalls);
      return;
    }
    case "terminal":
      selected.terminals.push(ev.terminal);
      renderCalls(selected);
      renderDetail(selected);
      return;
    case "status":
      selected.status = ev.status;
      if (ev.message !== undefined) selected.message = ev.message;
      renderDetail(selected);
      return;
  }
});

// ---- Amorçage -------------------------------------------------------------
void window.sunflower.workSettingsGet().then(renderSettings);
void window.sunflower.workList().then((next) => {
  sessions = next;
  renderSessions();
  autoSelect();
});
renderDetail(null);
