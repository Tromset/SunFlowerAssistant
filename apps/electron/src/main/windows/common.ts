import { BrowserWindow } from "electron";
import path from "node:path";

export function preloadPath(): string {
  return path.join(__dirname, "..", "preload", "index.cjs");
}

export function rendererFile(name: string): string {
  return path.join(__dirname, "..", "renderer", name);
}

/**
 * Fenêtre de superposition : transparente, sans focus, traversée par la
 * souris, toujours au premier plan, exclue des captures d'écran.
 */
export function createOverlayWindow(opts: {
  width: number;
  height: number;
  show?: boolean;
  /** Rare : superposition qui doit recevoir focus/souris (le rond du bord droit,
   *  seul élément interactif — les autres restent traversés par la souris). */
  focusable?: boolean;
  /** Par défaut le throttling reste coupé (île, compagnon, rond :
   *  animations visibles en continu). Le passer à true pour les superpositions
   *  souvent masquées (pointer) : Chromium ralentit alors leurs timers quand
   *  elles sont cachées au lieu de brûler du CPU en fond. */
  backgroundThrottling?: boolean;
  /** Rare : superposition redimensionnée par programme (le pointer, dont le
   *  cadre suit la taille de l'élément visé). Fenêtre traversée par la souris,
   *  donc aucun redimensionnement utilisateur possible malgré tout. */
  resizable?: boolean;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    show: false,
    transparent: true,
    frame: false,
    resizable: opts.resizable ?? false,
    movable: false,
    focusable: opts.focusable ?? false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: opts.backgroundThrottling ?? false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  return win;
}
