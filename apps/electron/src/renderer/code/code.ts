// Sunflower-Code — the coding harness, out of the terminal. Three columns:
// what the model may do on the left, what it is saying in the middle, what it
// changed on disk on the right.
//
// Le rendu suit les deux règles de l'app Work :
//  - un événement ne redessine que ce qu'il touche (un token s'ajoute au bloc
//    en cours, il ne reconstruit pas la transcription) ;
//  - le défilement reste collant tant que l'utilisateur est en bas, et se
//    relâche dès qu'il remonte pour lire.
//
// Et sa contrainte : AUCUN minuteur. Tout arrive par sf:code:event, et le
// « ça réfléchit » est une animation CSS. Voir CLAUDE.md — le budget
// always-on est plein, cette fenêtre ne doit rien coûter au repos.
import { ensureBridge } from "../shared/dev-stub";
import { POSES, pixelArtSvg } from "../../shared/sunflower-pixels";
import { diffLines } from "../../shared/diff";
import type { DiffLine } from "../../shared/diff";
import {
  CODE_COMPACT_AT_TOKENS,
  CODE_MODES,
  CODE_MODE_HELP,
  CODE_PERMISSIONS,
  CODE_PERMISSION_HELP,
  CODE_TOOLS,
  CODE_TOOL_EFFECT,
  codeMaxTurns,
  denyReason,
  gateFor,
  toolsFor,
} from "../../shared/code";
import type {
  CodeAppEvent,
  CodeAppState,
  CodeEntry,
  CodeMode,
  CodePermission,
  CodeSessionInfo,
  CodeSessionStatus,
  CodeToolCall,
} from "../../shared/code";

import { DEFAULT_CONFIG } from "../../shared/config-schema";

ensureBridge();

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

$("title-icon").innerHTML = pixelArtSvg(POSES.idle, 16, 18);

const titleNote = $("title-note");
const titleDir = $("title-dir");
const modeList = $("mode-list");
const modeHelp = $("mode-help");
const permissionList = $("permission-list");
const permissionHelp = $("permission-help");
const toolList = $("tool-list");
const meterTurns = $("meter-turns");
const meterTurnsValue = $("meter-turns-value");
const meterTokens = $("meter-tokens");
const meterTokensValue = $("meter-tokens-value");
const renewalsEl = $("renewals");
const detailStatus = $("detail-status");
const detailClear = $<HTMLButtonElement>("detail-clear");
const detailInterrupt = $<HTMLButtonElement>("detail-interrupt");
const approval = $("approval");
const approvalWhat = $("approval-what");
const approvalEffect = $("approval-effect");
const approvalDiff = $("approval-diff");
const approvalAllow = $<HTMLButtonElement>("approval-allow");
const approvalDeny = $<HTMLButtonElement>("approval-deny");
const tabTalk = $("tab-talk");
const tabCalls = $("tab-calls");
const tabTerm = $("tab-term");
const viewTalk = $("view-talk");
const viewCalls = $("view-calls");
const viewTerm = $<HTMLPreElement>("view-term");
const transcriptEl = $("transcript");
const talkEmpty = $("talk-empty");
const callsEl = $("calls");
const callsEmpty = $("calls-empty");
const changesEl = $("changes");
const changesEmpty = $("changes-empty");
const composerText = $<HTMLTextAreaElement>("composer-text");
const composerSend = $<HTMLButtonElement>("composer-send");

let info: CodeSessionInfo = {
  mode: "code",
  permission: "normal",
  workdir: "",
  status: "idle",
  turns: 0,
  tokens: 0,
  messages: 0,
  maxTurns: codeMaxTurns(DEFAULT_CONFIG.effort),
};
let renewals = 0;
let pending: CodeToolCall | null = null;
/** Bloc de réponse en cours de streaming, ou null entre deux tours. */
let streamEl: HTMLElement | null = null;

const STATUS_BADGE: Record<CodeSessionStatus, [string, string]> = {
  idle: ["off", "idle"],
  thinking: ["run", "thinking"],
  working: ["run", "working"],
  "awaiting-approval": ["wait", "waiting for you"],
  failed: ["bad", "failed"],
};

const GATE_LABEL: Record<string, string> = {
  allow: "free",
  ask: "asks you",
  deny: "refused",
};

const busy = (): boolean => info.status !== "idle";

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

// ---- Défilement collant ---------------------------------------------------
function nearBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 32;
}
const stick = new WeakMap<HTMLElement, boolean>();
for (const el of [viewTalk, viewCalls, viewTerm, changesEl]) {
  stick.set(el, true);
  el.addEventListener("scroll", () => stick.set(el, nearBottom(el)));
}
function keepBottom(el: HTMLElement): void {
  if (stick.get(el) !== false) el.scrollTop = el.scrollHeight;
}

// ---- Colonne 1 : mode, permission, outils, jauges -------------------------
function choiceRow(
  label: string,
  help: string,
  selected: boolean,
  onPick: () => void,
): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `choice${selected ? " selected" : ""}${
    label === "yolo" ? " danger" : ""
  }`;
  row.textContent = label;
  row.title = help;
  row.addEventListener("click", onPick);
  return row;
}

function renderControls(): void {
  modeList.textContent = "";
  for (const mode of CODE_MODES) {
    modeList.append(
      choiceRow(mode, CODE_MODE_HELP[mode], mode === info.mode, () => {
        void window.sunflower.codeSetMode(mode as CodeMode);
      }),
    );
  }
  modeHelp.textContent = CODE_MODE_HELP[info.mode];

  permissionList.textContent = "";
  for (const permission of CODE_PERMISSIONS) {
    permissionList.append(
      choiceRow(
        permission,
        CODE_PERMISSION_HELP[permission],
        permission === info.permission,
        () => {
          void window.sunflower.codeSetPermission(
            permission as CodePermission,
          );
        },
      ),
    );
  }
  permissionHelp.textContent = CODE_PERMISSION_HELP[info.permission];

  // La vraie porte de chaque outil, calculée avec les mêmes fonctions que le
  // harnais — pas une paraphrase de la doc qui dériverait au premier réglage.
  const exposed = new Set(toolsFor(info.mode, info.permission));
  toolList.textContent = "";
  for (const tool of CODE_TOOLS) {
    const row = document.createElement("div");
    const open = exposed.has(tool);
    const gate = gateFor(info.permission, tool);
    row.className = `tool${open ? "" : " off"}`;
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool;
    const badge = document.createElement("span");
    badge.className = `badge ${gate === "allow" ? "ok" : gate === "ask" ? "wait" : "bad"}`;
    badge.textContent = open ? (GATE_LABEL[gate] ?? gate) : "not exposed";
    row.title = open
      ? `${CODE_TOOL_EFFECT[tool]} — ${GATE_LABEL[gate] ?? gate}`
      : info.mode === "chat"
        ? "chat mode exposes no tools at all."
        : denyReason(info.permission, tool);
    row.append(name, badge);
    toolList.append(row);
  }

  const turnPct = Math.min(100, (info.turns / info.maxTurns) * 100);
  meterTurns.style.width = `${turnPct}%`;
  meterTurnsValue.textContent = `${info.turns}/${info.maxTurns}`;
  const tokenPct = Math.min(100, (info.tokens / CODE_COMPACT_AT_TOKENS) * 100);
  meterTokens.style.width = `${tokenPct}%`;
  meterTokensValue.textContent = `${shortTokens(info.tokens)}/${shortTokens(
    CODE_COMPACT_AT_TOKENS,
  )}`;
  renewalsEl.textContent = `context renewed ${renewals}×`;
}

// ---- En-tête + composeur --------------------------------------------------
function renderHead(): void {
  const [cls, label] = STATUS_BADGE[info.status];
  detailStatus.className = `badge ${cls}`;
  detailStatus.textContent = label;
  detailInterrupt.hidden = !busy();
  titleDir.textContent = basename(info.workdir) || "no folder";
  titleDir.title = info.workdir;
  titleNote.textContent = busy()
    ? `${label} · turn ${info.turns}/${info.maxTurns} · ${shortTokens(info.tokens)} tokens`
    : `${info.mode} · ${info.permission}`;
  // Une session occupée n'accepte pas un second message (une conversation, un
  // tour à la fois) — sauf pendant un accord, où c'est le bandeau qui répond.
  const locked = busy() && info.status !== "awaiting-approval";
  composerText.disabled = locked;
  composerSend.disabled = locked;
}

// ---- Diff -----------------------------------------------------------------
function diffBlock(diff: readonly DiffLine[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "diff";
  for (const line of diff) {
    const row = document.createElement("span");
    row.className = `diff-line ${line.type}`;
    row.textContent = line.text;
    box.append(row);
  }
  return box;
}

function tallyChip(added: number, removed: number): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "tally";
  chip.textContent = `+${added} −${removed}`;
  return chip;
}

// ---- Appels d'outils ------------------------------------------------------
function callRow(call: CodeToolCall): HTMLElement {
  const row = document.createElement("div");
  row.className = `call ${call.status}`;
  row.dataset["call"] = String(call.id);

  const head = document.createElement("span");
  head.className = "call-head";
  const mark = document.createElement("span");
  mark.className = "call-mark";
  mark.textContent =
    call.status === "done" ? "✓" : call.status === "running" ? "▸" : call.status === "pending" ? "▸" : "✗";
  const name = document.createElement("span");
  name.className = "call-name";
  name.textContent = call.display;
  head.append(mark, name);
  for (const change of call.changes ?? []) {
    head.append(tallyChip(change.added, change.removed));
  }
  if (call.ms !== undefined) {
    const ms = document.createElement("span");
    ms.className = "call-ms";
    ms.textContent = `${call.ms}ms`;
    head.append(ms);
  }
  row.append(head);

  if (call.status === "done" && call.result) {
    const lines = call.result.split("\n");
    const result = document.createElement("span");
    result.className = "call-result";
    result.textContent = `${lines.length > 1 ? `${lines.length} lines · ` : ""}${lines[0] ?? ""}`;
    row.append(result);
  }
  if (call.note) {
    const note = document.createElement("span");
    note.className = "call-note";
    note.textContent = call.note;
    row.append(note);
  }
  for (const change of call.changes ?? []) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${change.path}  +${change.added} −${change.removed}`;
    details.append(summary, diffBlock(change.diff));
    row.append(details);
  }
  return row;
}

// ---- Transcription --------------------------------------------------------
function bubble(cls: string, text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  return div;
}

function entryNode(entry: CodeEntry): HTMLElement {
  switch (entry.kind) {
    case "user":
      return bubble("user", entry.text);
    case "answer":
      return bubble("sunflower", entry.text);
    case "tool":
      return callRow(entry.call);
    case "output": {
      const pre = document.createElement("pre");
      pre.className = "term inline";
      pre.dataset["out"] = String(entry.callId);
      pre.textContent = entry.text;
      return pre;
    }
    case "compacted": {
      const rule = document.createElement("div");
      rule.className = "rule";
      rule.textContent = `✦ ${shortTokens(entry.tokens)} tokens — context renewed`;
      return rule;
    }
    case "error": {
      const line = document.createElement("div");
      line.className = "entry-error";
      line.textContent = entry.message;
      return line;
    }
    case "note": {
      const line = document.createElement("div");
      line.className = "entry-note";
      line.textContent = entry.text;
      return line;
    }
  }
}

/** Ce que la colonne « terminal » montre : la sortie brute des commandes,
 *  tenue à part de la prose du modèle — c'est un terminal, pas une réponse. */
function appendTerm(text: string): void {
  viewTerm.append(document.createTextNode(text));
  keepBottom(viewTerm);
}

function appendChange(call: CodeToolCall): void {
  for (const change of call.changes ?? []) {
    const card = document.createElement("div");
    card.className = "change";
    const head = document.createElement("span");
    head.className = "change-head";
    const path = document.createElement("span");
    path.className = "change-path";
    path.textContent = change.path;
    path.title = change.path;
    head.append(path, tallyChip(change.added, change.removed));
    card.append(head, diffBlock(change.diff));
    changesEl.append(card);
    changesEmpty.hidden = true;
    keepBottom(changesEl);
  }
}

function appendEntry(entry: CodeEntry): void {
  talkEmpty.hidden = true;
  transcriptEl.append(entryNode(entry));
  keepBottom(viewTalk);
  if (entry.kind === "tool") {
    callsEmpty.hidden = true;
    callsEl.append(callRow(entry.call));
    keepBottom(viewCalls);
    appendChange(entry.call);
  } else if (entry.kind === "output") {
    appendTerm(entry.text);
  }
}

function renderAll(state: CodeAppState): void {
  info = state.info;
  renewals = state.renewals;
  pending = state.pending;
  streamEl = null;
  transcriptEl.textContent = "";
  callsEl.textContent = "";
  viewTerm.textContent = "";
  changesEl.textContent = "";
  changesEmpty.hidden = false;
  callsEmpty.hidden = state.entries.some((e) => e.kind === "tool");
  talkEmpty.hidden = state.entries.length > 0;
  for (const entry of state.entries) appendEntry(entry);
  // Un tour peut être EN VOL quand la fenêtre s'ouvre : on rattrape le fil au
  // lieu de commencer au milieu d'une phrase.
  if (state.draft) {
    streamEl = bubble("sunflower streaming", state.draft);
    transcriptEl.append(streamEl);
    keepBottom(viewTalk);
  }
  renderApproval(pending);
  renderHead();
  renderControls();
}

// ---- Accord ---------------------------------------------------------------
function renderApproval(call: CodeToolCall | null): void {
  pending = call;
  approval.hidden = call === null;
  if (!call) return;
  approvalWhat.textContent = call.display;
  approvalEffect.textContent = CODE_TOOL_EFFECT[call.name];
  // edit_file porte l'ancien et le nouveau texte dans ses arguments : le diff
  // se montre AVANT l'accord, quand il sert encore à décider.
  const oldText = call.args["old"];
  const newText = call.args["new"];
  const content = call.args["content"];
  approvalDiff.textContent = "";
  approvalDiff.hidden = true;
  if (typeof oldText === "string" && typeof newText === "string") {
    approvalDiff.append(...diffBlock(diffLines(oldText, newText)).childNodes);
    approvalDiff.hidden = false;
  } else if (typeof content === "string") {
    approvalDiff.append(...diffBlock(diffLines(null, content)).childNodes);
    approvalDiff.hidden = false;
  }
}

function answerApproval(ok: boolean): void {
  if (!pending) return;
  const callId = pending.id;
  // Optimiste : le bandeau part tout de suite. Le vrai effacement viendra de
  // l'événement `approval: null`, qui arrive aussi quand c'est le terminal
  // qui a répondu.
  renderApproval(null);
  void window.sunflower.codeApprove(callId, ok);
}
approvalAllow.addEventListener("click", () => answerApproval(true));
approvalDeny.addEventListener("click", () => answerApproval(false));

// ---- Onglets --------------------------------------------------------------
function showTab(which: "talk" | "calls" | "term"): void {
  tabTalk.classList.toggle("active", which === "talk");
  tabCalls.classList.toggle("active", which === "calls");
  tabTerm.classList.toggle("active", which === "term");
  viewTalk.hidden = which !== "talk";
  viewCalls.hidden = which !== "calls";
  viewTerm.hidden = which !== "term";
  keepBottom(which === "talk" ? viewTalk : which === "calls" ? viewCalls : viewTerm);
}
tabTalk.addEventListener("click", () => showTab("talk"));
tabCalls.addEventListener("click", () => showTab("calls"));
tabTerm.addEventListener("click", () => showTab("term"));

// ---- Composeur ------------------------------------------------------------
function send(): void {
  const text = composerText.value.trim();
  if (!text || composerSend.disabled) return;
  composerText.value = "";
  void window.sunflower.codeSend(text);
}
composerSend.addEventListener("click", send);
composerText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

detailInterrupt.addEventListener("click", () => {
  void window.sunflower.codeInterrupt();
});
detailClear.addEventListener("click", () => {
  void window.sunflower.codeClear();
});
titleDir.addEventListener("click", () => {
  void window.sunflower.codePickWorkdir();
});

// ---- Flux -----------------------------------------------------------------
window.sunflower.onCodeEvent((ev: CodeAppEvent) => {
  switch (ev.kind) {
    case "entry":
      // Une réponse complète remplace le bloc streamé : sans ça le texte
      // apparaîtrait deux fois.
      if (ev.entry.kind === "answer" && streamEl) {
        streamEl.remove();
        streamEl = null;
      }
      appendEntry(ev.entry);
      return;
    case "token":
      if (!streamEl) {
        streamEl = bubble("sunflower streaming", "");
        talkEmpty.hidden = true;
        transcriptEl.append(streamEl);
      }
      streamEl.textContent = (streamEl.textContent ?? "") + ev.text;
      keepBottom(viewTalk);
      return;
    case "tool": {
      // Le même appel change d'état : on remplace la ligne, on n'en ajoute pas.
      for (const host of [transcriptEl, callsEl]) {
        const row = host.querySelector<HTMLElement>(
          `.call[data-call="${ev.call.id}"]`,
        );
        if (row) row.replaceWith(callRow(ev.call));
      }
      appendChange(ev.call);
      keepBottom(viewTalk);
      return;
    }
    case "output":
      appendTerm(ev.text);
      return;
    case "approval":
      renderApproval(ev.call);
      return;
    case "info":
      info = ev.info;
      renewals = ev.renewals;
      renderHead();
      renderControls();
      return;
    case "reset":
      transcriptEl.textContent = "";
      callsEl.textContent = "";
      viewTerm.textContent = "";
      changesEl.textContent = "";
      changesEmpty.hidden = false;
      callsEmpty.hidden = false;
      talkEmpty.hidden = false;
      streamEl = null;
      renderApproval(null);
      return;
    case "done":
      if (streamEl) {
        streamEl.classList.remove("streaming");
        streamEl = null;
      }
      renderHead();
      return;
  }
});

// ---- Amorçage -------------------------------------------------------------
void window.sunflower.codeState().then(renderAll);
