import { BrowserWindow, screen } from "electron";
import { preloadPath, rendererFile } from "./common";

/** L'app Sunflower-Code : le harnais de codage sorti du terminal. Même
 *  traitement que Work — une vraie fenêtre, pas une superposition.
 *
 *  Deux détails comptent, pour les mêmes raisons que là-bas :
 *   - `setContentProtection(true)` : le mode `vision` de Sunflower-Code joint
 *     une capture de l'écran au message. Sans ça, il se photographierait
 *     lui-même et se mettrait à commenter sa propre interface.
 *   - la fenêtre est CACHÉE, pas détruite, à la fermeture : la session
 *     continue dans le terminal, et rouvrir doit retrouver la conversation.
 *
 *  Un peu plus large que Work (1100) : la transcription est prise en sandwich
 *  entre deux rails, elle a besoin de la place. */
export const CODE_W = 1180;
export const CODE_H = 780;
const CODE_MIN_W = 900;
const CODE_MIN_H = 580;

let win: BrowserWindow | null = null;

/** Crée (une fois) la fenêtre Sunflower-Code, chargée mais masquée. */
export async function createCodeWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  const { workArea } = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  );
  const width = Math.min(CODE_W, workArea.width - 40);
  const height = Math.min(CODE_H, workArea.height - 40);
  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(CODE_MIN_W, width),
    minHeight: Math.min(CODE_MIN_H, height),
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    show: false,
    title: "sunflower code",
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
  win.setContentProtection(true);
  // Fermer = ranger. La session continue de tourner derrière, et le terminal
  // garde la main dessus.
  win.on("close", (event) => {
    if (win && !win.isDestroyed() && win.isVisible()) {
      event.preventDefault();
      win.hide();
    }
  });
  await win.loadFile(rendererFile("code/code.html"));
  return win;
}

/** Ouvre l'app (la crée au premier appel) et la met au premier plan. */
export async function openCodeWindow(): Promise<BrowserWindow> {
  const target = await createCodeWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

/** La fenêtre si elle existe encore (diffusion des événements). */
export function codeWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** Laisse l'app se fermer pour de bon (appelé au before-quit). */
export function releaseCodeWindow(): void {
  if (win && !win.isDestroyed()) {
    win.removeAllListeners("close");
    win.destroy();
  }
  win = null;
}
