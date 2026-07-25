import { BrowserWindow, screen } from "electron";
import { preloadPath, rendererFile } from "./common";

/** L'app Sunflower Work : une vraie fenêtre, pas une superposition. C'est le
 *  poste de pilotage des runs longs — liste des agents, création, chatbox,
 *  flux terminal, appels d'outils.
 *
 *  Deux détails comptent :
 *   - `setContentProtection(true)` : le run de travail prend des captures de
 *     l'écran pour décider du geste suivant. Sans ça, il se verrait
 *     lui-même et se mettrait à commenter sa propre interface.
 *   - la fenêtre est CACHÉE, pas détruite, à la fermeture : rouvrir depuis le
 *     panneau ou le tray doit retrouver la session en cours instantanément. */
export const WORK_W = 1100;
export const WORK_H = 720;
const WORK_MIN_W = 820;
const WORK_MIN_H = 560;

let win: BrowserWindow | null = null;

/** Crée (une fois) la fenêtre Work, chargée mais masquée. */
export async function createWorkWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  const { workArea } = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  );
  const width = Math.min(WORK_W, workArea.width - 40);
  const height = Math.min(WORK_H, workArea.height - 40);
  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(WORK_MIN_W, width),
    minHeight: Math.min(WORK_MIN_H, height),
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    show: false,
    title: "sunflower work",
    backgroundColor: "#141413",
    // Barre de titre masquée mais boutons de fenêtre gardés : l'app reste
    // fermable/déplaçable à la souris, sans chrome clair sur fond encre.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Le run de travail regarde l'écran : sa propre interface doit en être
  // absente, comme toutes les autres fenêtres de sunflower.
  win.setContentProtection(true);
  // Fermer = ranger. La session continue de tourner derrière.
  win.on("close", (event) => {
    if (win && !win.isDestroyed() && win.isVisible()) {
      event.preventDefault();
      win.hide();
    }
  });
  await win.loadFile(rendererFile("work/work.html"));
  return win;
}

/** Ouvre l'app Work (la crée au premier appel) et la met au premier plan. */
export async function openWorkWindow(): Promise<BrowserWindow> {
  const target = await createWorkWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

/** La fenêtre si elle existe encore (diffusion des événements). */
export function workWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** Laisse l'app se fermer pour de bon (appelé au before-quit). */
export function releaseWorkWindow(): void {
  if (win && !win.isDestroyed()) {
    win.removeAllListeners("close");
    win.destroy();
  }
  win = null;
}
