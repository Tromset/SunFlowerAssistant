import { BrowserWindow, app, screen } from "electron";
import { preloadPath, rendererFile } from "./common";

export const PANEL_W = 400;
/** Hauteur de départ, avant que le renderer n'ait mesuré sa carte. */
export const PANEL_H = 620;
/** Plancher : en dessous, la carte ne peut plus rien montrer d'utile. */
const PANEL_MIN_H = 220;
/** Air laissé sous la fenêtre : la carte porte une ombre, et un panneau collé
 *  au bord bas de l'écran a l'air rogné même quand il ne l'est pas. */
const BOTTOM_MARGIN = 12;
/** Largeur de la carte visible dans la fenêtre transparente. */
const CARD_W = 320;

/** Dernière hauteur demandée par le renderer (voir CH.panelResize). */
let wantedHeight = PANEL_H;

/**
 * Sur macOS, cliquer l'icône de tray pendant que le panneau est ouvert
 * déclenche d'abord `blur` (le panneau se cache) puis le clic : sans garde,
 * le panneau se rouvrirait aussitôt au lieu de se fermer.
 */
let hiddenAt = 0;

export async function createPanelWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Throttling laissé actif (défaut) : le panneau est masqué l'essentiel
      // du temps, inutile de garder ses timers à pleine cadence en fond.
    },
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true);
  win.on("blur", () => {
    if (win.isVisible()) {
      hiddenAt = Date.now();
      win.hide();
    }
  });
  await win.loadFile(rendererFile("panel/panel.html"));
  return win;
}

/** Hauteur réellement applicable : ce que la carte demande, borné à l'écran. */
function clampHeight(win: BrowserWindow, height: number): number {
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const max = Math.max(PANEL_MIN_H, area.height - 2 - BOTTOM_MARGIN);
  return Math.round(Math.min(max, Math.max(PANEL_MIN_H, height)));
}

/**
 * Ajuste la fenêtre à la hauteur réelle de la carte. Sans ça, la fenêtre
 * gardait une hauteur fixe : une carte plus longue (beaucoup de sections, avec
 * diffs) était coupée net par le bas et perdait ses deux coins arrondis, ce
 * qui donnait cette impression de panneau « qui ne se termine pas ».
 * La carte plus haute que l'écran, elle, défile à l'intérieur (voir panel.css).
 */
export function resizePanel(win: BrowserWindow, height: number): void {
  if (win.isDestroyed() || !Number.isFinite(height)) return;
  wantedHeight = Math.max(PANEL_MIN_H, Math.round(height));
  const next = clampHeight(win, wantedHeight);
  const bounds = win.getBounds();
  if (bounds.height === next) return;
  win.setBounds({ ...bounds, height: next });
}

export function togglePanel(
  win: BrowserWindow,
  trayBounds: Electron.Rectangle,
): void {
  if (win.isVisible()) {
    hiddenAt = Date.now();
    win.hide();
    return;
  }
  if (Date.now() - hiddenAt < 350) return;
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x + trayBounds.width / 2,
    y: trayBounds.y + trayBounds.height / 2,
  });
  const area = display.workArea;
  const pad = (PANEL_W - CARD_W) / 2;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_W / 2);
  // La carte visible (centrée dans la fenêtre) doit rester dans l'écran.
  x = Math.min(x, area.x + area.width - CARD_W - 8 - pad);
  x = Math.max(x, area.x + 8 - pad);
  const y = area.y + 2;
  const max = Math.max(PANEL_MIN_H, area.height - 2 - BOTTOM_MARGIN);
  const height = Math.round(Math.min(max, Math.max(PANEL_MIN_H, wantedHeight)));
  win.setBounds({ x, y, width: PANEL_W, height });
  win.show();
  app.focus({ steal: true });
}
