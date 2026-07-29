// Panel: live status (permissions, model, voice), app launchers, quit.
import { ensureBridge } from "../shared/dev-stub";
import { POSES, pixelArtSvg } from "../../shared/sunflower-pixels";
import { ACTIVITY_LABELS, type ActivitySnapshot } from "../../shared/activity";
import type { WorkSettings } from "../../shared/work";
import {
  claudeStateLabel,
  type ClaudeStatus,
  type ClaudeTask,
} from "../../shared/claude";
import type { PanelData, PermissionId } from "../../shared/state";

ensureBridge();

document.getElementById("brand-icon")!.innerHTML = pixelArtSvg(
  POSES.idle,
  15,
  17,
);

const liveDot = document.getElementById("live-dot")!;
const liveLabel = document.getElementById("live-label")!;
const modelName = document.getElementById("model-name")!;
const modelBadge = document.getElementById("model-badge")!;
const voiceSub = document.getElementById("voice-sub")!;
const voiceBadge = document.getElementById("voice-badge")!;
const versionEl = document.querySelector(".version")!;

let sttStatus = "loading";

function renderPermissions(data: PanelData): void {
  for (const row of document.querySelectorAll<HTMLElement>(".perm-row")) {
    const id = row.dataset["perm"] as PermissionId;
    const granted = data.permissions[id] === "granted";
    row.classList.toggle("granted", granted);
    row.querySelector(".perm-status")!.innerHTML =
      `<span class="dot"></span>${granted ? "granted" : "not granted"}`;
    // Screen recording needs a relaunch after the macOS grant.
    if (id === "screen") {
      row.title = granted
        ? ""
        : "checked in System Settings? quit and relaunch sunflower.";
    }
  }
}

function renderModel(data: PanelData): void {
  modelName.textContent = data.model.name;
  const set = (cls: string, text: string) => {
    modelBadge.className = `badge ${cls}`;
    modelBadge.textContent = text;
  };
  if (!data.model.reachable) set("off", "[--] offline");
  else if (!data.model.pulled) set("warn", "[!!] to download");
  else set("ok", "[ok] local");
}

function renderVoice(data: PanelData): void {
  sttStatus = data.stt.status;
  const short = data.stt.model
    .replace(/^ggml-/, "")
    .replace(/\.bin$/, "")
    .replace(/-q\d.*$/, "");
  voiceSub.textContent = `whisper · ${short}`;
  const set = (cls: string, text: string, action = false) => {
    voiceBadge.className = `badge ${cls}${action ? " action" : ""}`;
    voiceBadge.textContent = text;
  };
  switch (data.stt.status) {
    case "ready":
      set("ok", "[ok] local");
      break;
    case "downloading":
      set("off", `[..] ${data.stt.progress ?? 0}%`);
      break;
    case "loading":
      set("off", "[..] loading");
      break;
    case "absent":
      set("warn", "[--] download", true);
      break;
    default:
      set("warn", "[!!] unavailable");
      if (data.stt.error) voiceBadge.title = data.stt.error;
  }
}

function render(data: PanelData): void {
  liveDot.classList.toggle("off", !data.hotkeyAvailable);
  liveLabel.textContent = data.hotkeyAvailable ? "active" : "waiting";
  versionEl.textContent = `v${data.version.split(".").slice(0, 2).join(".")} · 100% local`;
  renderPermissions(data);
  renderModel(data);
  renderVoice(data);
  reportHeight();
}

for (const row of document.querySelectorAll<HTMLElement>(".perm-row")) {
  row.addEventListener("click", () => {
    if (!row.classList.contains("granted")) {
      void window.sunflower.requestPermission(
        row.dataset["perm"] as PermissionId,
      );
    }
  });
}

voiceBadge.addEventListener("click", () => {
  if (sttStatus === "absent") void window.sunflower.downloadWhisper();
});

const tabWork = document.getElementById("tab-work")!;
const tabCode = document.getElementById("tab-code")!;
const viewHome = document.getElementById("view-home")!;
// « home » est la seule vue : les deux autres onglets ne changent pas de vue,
// ils lancent chacun leur app dédiée (fenêtre à part).
tabWork.addEventListener("click", () => {
  void window.sunflower.workOpen();
});
tabCode.addEventListener("click", () => {
  void window.sunflower.codeOpen();
});

// ---- Hauteur de la fenêtre = hauteur réelle de la carte -----------------
// La fenêtre du panneau est transparente et de taille fixe côté Electron :
// une carte plus haute qu'elle se faisait rogner par le bas, coins arrondis
// compris. On mesure la hauteur NATURELLE (châssis + contenu de la vue qui
// défile) et la fenêtre s'y ajuste, bornée à l'écran par le main.
const card = document.getElementById("card")!;
/** Marges verticales du body (6 en haut, 8 en bas) + les deux bordures. */
const CARD_MARGIN = 16;
let lastReported = 0;

/** Mesure SYNCHRONE, volontairement : le panneau passe l'essentiel de sa vie
 *  masqué, et Chromium met en pause requestAnimationFrame dans une fenêtre
 *  cachée. Différer la mesure voulait dire ouvrir une première fois à la
 *  mauvaise hauteur, puis la voir sauter. Lire la mise en page depuis un
 *  ResizeObserver est sans danger tant qu'on n'y écrit pas — la fenêtre, elle,
 *  est redimensionnée par le main, de façon asynchrone. */
function reportHeight(): void {
  // Le châssis (en-tête, raccourci, onglets, pied) ne dépend pas de la
  // taille de la fenêtre : c'est la carte moins la vue qui défile.
  const chrome = card.clientHeight - viewHome.clientHeight;
  const natural = Math.ceil(chrome + viewHome.scrollHeight) + CARD_MARGIN;
  if (Math.abs(natural - lastReported) < 2) return;
  lastReported = natural;
  window.sunflower.panelResize(natural);
}

const heightWatcher = new ResizeObserver(() => reportHeight());
heightWatcher.observe(card);
heightWatcher.observe(viewHome);

// ---- Quitter : un vrai bouton, un vrai arrêt ---------------------------
const quitBtn = document.getElementById("quit") as HTMLButtonElement;
quitBtn.addEventListener("click", () => {
  // Le main coupe session de code, runs de travail, voix et fenêtres avant
  // de sortir
  // (voir shutdownEverything dans main/index.ts) : ça peut prendre un
  // instant, autant le dire au lieu de laisser le bouton inerte.
  quitBtn.disabled = true;
  quitBtn.textContent = "closing everything…";
  void window.sunflower.quit();
});

// ---- Humeurs contextuelles ---------------------------------------------
const moodsEnable = document.getElementById("moods-enable") as HTMLInputElement;
const moodSub = document.getElementById("mood-sub")!;
const moodBadge = document.getElementById("mood-badge")!;
let moodsOn = true;
let lastMood: ActivitySnapshot = { context: "none", app: "", host: "" };

function renderMood(): void {
  if (!moodsOn) {
    moodBadge.className = "badge off";
    moodBadge.textContent = "[--] off";
    moodSub.textContent = "the sunflower stays plain";
    return;
  }
  const known = lastMood.context !== "none";
  moodBadge.className = `badge ${known ? "ok" : "off"}`;
  moodBadge.textContent = known ? "[ok] on" : "[..] watching";
  const where = lastMood.host || lastMood.app;
  moodSub.textContent = known
    ? `${ACTIVITY_LABELS[lastMood.context]}${where ? ` · ${where}` : ""}`
    : "nothing in particular";
}

moodsEnable.addEventListener("change", () => {
  moodsOn = moodsEnable.checked;
  renderMood();
  void window.sunflower.setConfig({ moodsEnabled: moodsOn });
});

window.sunflower.onActivity((snapshot) => {
  lastMood = snapshot;
  renderMood();
});

// ---- Sunflower Work -----------------------------------------------------
const workEnable = document.getElementById("work-enable") as HTMLInputElement;
const workSub = document.getElementById("work-sub")!;

function renderWork(settings: WorkSettings): void {
  workEnable.checked = settings.enabled;
  if (!settings.enabled) {
    workSub.textContent = "off — nothing is ever touched";
    return;
  }
  // Le départ est immédiat par défaut ; le dire, sinon l'ancien « 20s idle »
  // laissait croire qu'il faut quitter son bureau.
  const start =
    settings.requiredIdleSec > 0
      ? `starts after ${settings.requiredIdleSec}s idle`
      : "starts right away";
  const back =
    settings.onUserInput === "stop" ? "stops when you're back" : "yields to you";
  workSub.textContent = `on · ${start} · ${back} · ${settings.maxSteps} steps max`;
}

workEnable.addEventListener("change", () => {
  void window.sunflower
    .workSettingsSet({ enabled: workEnable.checked })
    .then(renderWork);
});
document.getElementById("work-open")!.addEventListener("click", () => {
  void window.sunflower.workOpen();
});
void window.sunflower.workSettingsGet().then(renderWork);

// ---- Pont Claude Code ---------------------------------------------------
// « Se connecter à Claude et ses tâches » se voit ici : combien de sessions
// tournent, et où. La notification, elle, est l'onde du compagnon.
const claudeEnable = document.getElementById(
  "claude-enable",
) as HTMLInputElement;
const claudeSub = document.getElementById("claude-sub")!;
const claudeBadge = document.getElementById("claude-badge")!;
const claudeProblem = document.getElementById("claude-problem")!;
let claudeTasks: ClaudeTask[] = [];
let claudeState: ClaudeStatus = {
  enabled: false,
  install: "absent",
  active: 0,
};

/** Ce qui cloche, en clair — les réglages de Claude sont à l'utilisateur, pas
 *  à nous : on montre l'écart au lieu de le recoller en douce. */
function claudeTrouble(status: ClaudeStatus): string {
  if (status.problem) return status.problem;
  switch (status.install) {
    case "no-claude":
      return "claude code isn't installed on this mac.";
    case "stale":
      return "the hooks are there but sunflower's script is gone — tick again.";
    case "partial":
      return "claude's settings were edited by hand — tick again to repair.";
    default:
      return "";
  }
}

function renderClaude(): void {
  claudeEnable.checked = claudeState.enabled;
  claudeEnable.disabled =
    claudeState.install === "no-claude" || claudeState.install === "unreadable";

  const trouble = claudeTrouble(claudeState);
  claudeProblem.textContent = trouble;
  claudeProblem.hidden = !trouble;

  if (!claudeState.enabled) {
    claudeBadge.className = "badge off";
    claudeBadge.textContent = "[--] off";
    claudeSub.textContent = "off — claude's settings are untouched";
    return;
  }
  const live = claudeTasks.filter(
    (t) => t.status === "working" || t.status === "waiting",
  );
  claudeBadge.className = `badge ${live.length ? "ok" : "off"}`;
  claudeBadge.textContent = live.length ? "[ok] busy" : "[..] listening";
  if (live.length) {
    // Un seul projet : on le nomme. Plusieurs : on compte, la pastille est
    // trop étroite pour une liste, et le détail est dans /claude.
    claudeSub.textContent =
      live.length === 1 && live[0]
        ? `${live[0].project} · ${claudeStateLabel(live[0])}`
        : `${live.length} sessions running`;
    return;
  }
  const last = claudeTasks[0];
  claudeSub.textContent = last
    ? `last: ${last.project} · done`
    : "no claude session yet";
}

claudeEnable.addEventListener("change", () => {
  const want = claudeEnable.checked;
  void window.sunflower.claudeSetEnabled(want).then((result) => {
    claudeState = {
      enabled: result.enabled,
      install: result.install,
      active: claudeState.active,
      ...(result.problem ? { problem: result.problem } : {}),
    };
    if (result.ok && result.enabled && result.note) {
      claudeProblem.textContent = result.note;
      claudeProblem.hidden = false;
      renderClaudeKeepNote();
      return;
    }
    renderClaude();
  });
});

/** Comme renderClaude, mais sans écraser la précision « ouvre une nouvelle
 *  session » qu'on vient d'afficher : Claude ne lit ses hooks qu'au démarrage
 *  d'une session, et sans le dire la fonctionnalité passe pour cassée. */
function renderClaudeKeepNote(): void {
  const note = claudeProblem.textContent;
  renderClaude();
  if (note && !claudeTrouble(claudeState)) {
    claudeProblem.textContent = note;
    claudeProblem.hidden = false;
  }
}

window.sunflower.onClaudeChanged((tasks) => {
  claudeTasks = tasks;
  renderClaude();
});

void window.sunflower.claudeStatus().then((status) => {
  claudeState = status;
  renderClaude();
});

// ---- Compagnon : roam ↔ dock ------------------------------------------
// Même état que le menu du tray et le double-clic sur la fleur ; on passe par
// la bascule partagée (companionToggleDock) pour ne garder qu'une seule source
// de vérité (companionMode dans la config).
const segRoam = document.getElementById("seg-roam")!;
const segDock = document.getElementById("seg-dock")!;

function renderCompanionMode(docked: boolean): void {
  segRoam.classList.toggle("active", !docked);
  segDock.classList.toggle("active", docked);
}

function applyCompanionMode(targetDocked: boolean): void {
  // Déjà dans l'état voulu : ne rien basculer (la bascule est un toggle).
  if (segDock.classList.contains("active") === targetDocked) return;
  void window.sunflower.companionToggleDock().then(async () => {
    // onCompanionDocked ne se déclenche que si la fenêtre du compagnon est
    // vivante ; on relit la config pour refléter l'état dans tous les cas.
    const cfg = await window.sunflower.getConfig();
    renderCompanionMode(cfg.companionMode === "docked");
  });
}

segRoam.addEventListener("click", () => applyCompanionMode(false));
segDock.addEventListener("click", () => applyCompanionMode(true));

// Rester synchro quand la bascule vient d'ailleurs (tray, double-clic).
window.sunflower.onCompanionDocked(renderCompanionMode);
void window.sunflower.getConfig().then((cfg) => {
  renderCompanionMode(cfg.companionMode === "docked");
  moodsOn = cfg.moodsEnabled;
  moodsEnable.checked = moodsOn;
  renderMood();
});

window.sunflower.onPanelData(render);
void window.sunflower.getStatus().then(render);
