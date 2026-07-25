// Détection globale du maintien/relâchement de ⌃⌥ via uiohook-napi, plus
// les clics souris globaux (avancement des guides) et la garde de présence
// (Sunflower Work — voir presence.ts). Chargement défensif : sans le module
// natif ou sans la permission Accessibilité, l'app tourne quand même
// (hotkey, clics et garde de présence indisponibles).
import { systemPreferences } from "electron";
import { noteGlobalInput } from "./presence";

interface UiohookEvent {
  keycode: number;
}
interface UiohookModule {
  uIOhook: {
    on(event: "keydown" | "keyup", cb: (e: UiohookEvent) => void): void;
    on(
      event: "mousedown" | "mouseup" | "mousemove" | "wheel",
      cb: () => void,
    ): void;
    start(): void;
    stop(): void;
  };
  UiohookKey?: Record<string, number>;
}

let mod: UiohookModule | null = null;
let loadFailed = false;
let started = false;
let retryTimer: NodeJS.Timeout | null = null;
const mouseSubs = new Set<() => void>();

export function hotkeyAvailable(): boolean {
  return started;
}

/** Le hook souris partage le cycle de vie du hook clavier. */
export function mouseHookAvailable(): boolean {
  return started;
}

/** Abonnement aux clics globaux (signal seul — la position vient d'Electron). */
export function onGlobalMouseDown(cb: () => void): () => void {
  mouseSubs.add(cb);
  return () => {
    mouseSubs.delete(cb);
  };
}

export function initHotkey(handlers: {
  onDown: () => void;
  onUp: () => void;
}): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("uiohook-napi") as UiohookModule;
  } catch (err) {
    loadFailed = true;
    console.error("[sunflower] uiohook-napi unavailable:", err);
    return;
  }
  const K = mod.UiohookKey ?? {};
  const CTRL = new Set([K["Ctrl"] ?? 29, K["CtrlRight"] ?? 3613]);
  const ALT = new Set([K["Alt"] ?? 56, K["AltRight"] ?? 3640]);
  let ctrl = false;
  let alt = false;
  let active = false;
  mod.uIOhook.on("keydown", (e) => {
    noteGlobalInput("keyboard");
    if (CTRL.has(e.keycode)) ctrl = true;
    else if (ALT.has(e.keycode)) alt = true;
    else return;
    if (ctrl && alt && !active) {
      active = true;
      handlers.onDown();
    }
  });
  mod.uIOhook.on("keyup", (e) => {
    noteGlobalInput("keyboard");
    if (CTRL.has(e.keycode)) ctrl = false;
    else if (ALT.has(e.keycode)) alt = false;
    else return;
    if (active && !(ctrl && alt)) {
      active = false;
      handlers.onUp();
    }
  });
  mod.uIOhook.on("mousedown", () => {
    noteGlobalInput("mouse");
    for (const cb of mouseSubs) cb();
  });
  // Garde de présence seule : tout mouvement/molette/relâchement compte
  // comme « l'utilisateur est là » (noteGlobalInput est très bon marché).
  mod.uIOhook.on("mouseup", () => noteGlobalInput("mouse"));
  mod.uIOhook.on("mousemove", () => noteGlobalInput("mouse"));
  mod.uIOhook.on("wheel", () => noteGlobalInput("mouse"));
  // Accessibilité pas encore accordée : on réessaie, mais en RALENTISSANT.
  // La première version tournait à 3 s pour toujours — une charge
  // toujours-active de plus, jamais déclarée (voir le budget de CLAUDE.md).
  // Un `setInterval` figé ne peut pas ralentir : c'est une chaîne de
  // `setTimeout`, qui s'arrête net dès que le hook démarre.
  if (!tryStart()) scheduleRetry(RETRY_START_MS);
}

/** Cadence de départ, puis ×2 à chaque échec, plafonnée. */
const RETRY_START_MS = 3000;
const RETRY_MAX_MS = 60_000;

function scheduleRetry(delayMs: number): void {
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (tryStart()) return; // accordée : plus rien à réessayer
    scheduleRetry(Math.min(delayMs * 2, RETRY_MAX_MS));
  }, delayMs);
  retryTimer.unref();
}

function tryStart(): boolean {
  if (started || loadFailed || !mod) return started;
  if (!systemPreferences.isTrustedAccessibilityClient(false)) return false;
  try {
    mod.uIOhook.start();
    started = true;
  } catch (err) {
    loadFailed = true;
    console.error("[sunflower] uiohook start failed:", err);
  }
  return started;
}

export function stopHotkey(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (started && mod) {
    try {
      mod.uIOhook.stop();
    } catch {
      // rien à faire à la fermeture
    }
    started = false;
  }
}
