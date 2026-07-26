import { screen, type BrowserWindow, type Display, type Rectangle } from "electron";
import { CH } from "../../shared/ipc";
import type { OrbRun } from "../../shared/orb";
import { getConfig, setConfig } from "../config-store";
import { createOverlayWindow, rendererFile } from "./common";

/** Diamètre du rond (doit coïncider avec orb.css). */
export const ORB_D = 56;
/** Hauteur de la fenêtre : le disque + un peu d'air pour l'anneau de pulsation. */
const ORB_WIN_H = 80;
/** Largeur repliée : juste le disque (petite emprise au bord droit). */
const ORB_COLLAPSED_W = 80;
/** Largeur déployée au survol : place pour la pastille de statut à gauche. */
const ORB_EXPANDED_W = 340;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Fenêtre ancrée au bord droit de `display` ; `ratio` (0..1) = position
 *  verticale du centre du rond dans la zone de travail. Le rond reste au bord
 *  droit (le disque est aligné à droite côté CSS), la pastille se déploie
 *  vers la gauche. */
function boundsFor(
  display: Display,
  expanded: boolean,
  ratio: number,
): Rectangle {
  const { workArea } = display;
  const width = expanded ? ORB_EXPANDED_W : ORB_COLLAPSED_W;
  const height = ORB_WIN_H;
  const x = workArea.x + workArea.width - width;
  const centerY = workArea.y + clamp(ratio, 0, 1) * workArea.height;
  const y = Math.round(
    clamp(
      centerY - height / 2,
      workArea.y,
      workArea.y + workArea.height - height,
    ),
  );
  return { x, y, width, height };
}

function ratioFromCenterY(display: Display, centerY: number): number {
  const { workArea } = display;
  return clamp((centerY - workArea.y) / workArea.height, 0, 1);
}

/** L'écran où l'utilisateur travaille (curseur), pas forcément le principal. */
function displayAtCursor(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

export async function createOrbWindow(): Promise<BrowserWindow> {
  // focusable reste faux : le rond reçoit survol/glisser/clic sans jamais
  // voler le focus de l'app au premier plan (le clic ouvre le panneau
  // via IPC, aucun focus clavier n'est nécessaire).
  const win = createOverlayWindow({
    width: ORB_COLLAPSED_W,
    height: ORB_WIN_H,
  });
  // Contrairement aux autres superpositions (traversées par la souris), le rond
  // est interactif : survol, glisser vertical et clic.
  win.setIgnoreMouseEvents(false);
  win.setBounds(boundsFor(displayAtCursor(), false, getConfig().orbY));
  await win.loadFile(rendererFile("orb/orb.html"));
  return win;
}

/**
 * Pilote le rond : visible uniquement le temps qu'un run Code ou Work tourne
 * (show/hide), diffuse le statut courant (setStatus, charge utile orbChanged),
 * s'élargit au survol (setExpanded) et se repositionne au glisser vertical
 * (dragStart/Move/End, position persistée dans config.orbY).
 */
export interface OrbController {
  show(): void;
  hide(): void;
  setStatus(runs: OrbRun[]): void;
  setExpanded(expanded: boolean): void;
  dragStart(screenY: number): void;
  dragMove(screenY: number): void;
  dragEnd(screenY: number): void;
  dispose(): void;
}

export function createOrbController(win: BrowserWindow): OrbController {
  let ratio = clamp(getConfig().orbY, 0, 1);
  let expanded = false;
  let dragging = false;
  /** Décalage (points) entre le point saisi et le centre du rond, mémorisé au
   *  début du glisser pour que le rond ne « saute » pas sous le curseur. */
  let grabOffsetY = 0;
  let visible = false;
  /** Écran d'ancrage : choisi à chaque show() (écran du curseur), figé le
   *  temps que le rond est visible pour que le glisser reste cohérent. */
  let disp = displayAtCursor();
  /** Re-poussé quand le rond réapparaît, pour qu'il n'affiche pas un état
   *  périmé en attendant le prochain changement. */
  let lastRuns: OrbRun[] = [];

  const apply = () => {
    if (!win.isDestroyed()) win.setBounds(boundsFor(disp, expanded, ratio));
  };

  const centerY = () => {
    const b = win.getBounds();
    return b.y + b.height / 2;
  };

  // Le listener vit sur `screen` (global au process) : le retirer à la
  // destruction de la fenêtre pour ne pas fuir.
  const onMetricsChanged = () => {
    // L'écran d'ancrage a pu disparaître ou changer de géométrie.
    disp =
      screen.getAllDisplays().find((d) => d.id === disp.id) ?? displayAtCursor();
    if (visible) apply();
  };
  screen.on("display-metrics-changed", onMetricsChanged);
  win.once("closed", () => {
    screen.removeListener("display-metrics-changed", onMetricsChanged);
  });

  return {
    show() {
      if (win.isDestroyed()) return;
      expanded = false;
      dragging = false;
      // Le rond apparaît sur l'écran où l'utilisateur travaille, pas
      // forcément le principal.
      disp = displayAtCursor();
      apply();
      // Le renderer peut garder un état « déployé »/« glisser » d'une vie
      // antérieure : le resynchroniser avec la fenêtre repliée.
      win.webContents.send(CH.orbReset);
      if (!win.isVisible()) win.showInactive();
      visible = true;
      // Repousser le dernier statut connu au rond fraîchement affiché.
      if (lastRuns.length > 0) win.webContents.send(CH.orbChanged, lastRuns);
    },
    hide() {
      if (win.isDestroyed()) return;
      expanded = false;
      dragging = false;
      visible = false;
      win.webContents.send(CH.orbReset);
      if (win.isVisible()) win.hide();
    },
    setStatus(runs) {
      lastRuns = runs;
      if (!win.isDestroyed()) win.webContents.send(CH.orbChanged, runs);
    },
    setExpanded(next) {
      // Pendant un glisser, la largeur est figée pour éviter un saut latéral.
      if (dragging || expanded === next) return;
      expanded = next;
      apply();
    },
    dragStart(screenY) {
      dragging = true;
      grabOffsetY = screenY - centerY();
    },
    dragMove(screenY) {
      if (!dragging) return;
      ratio = ratioFromCenterY(disp, screenY - grabOffsetY);
      apply();
    },
    dragEnd(screenY) {
      if (!dragging) return;
      dragging = false;
      ratio = ratioFromCenterY(disp, screenY - grabOffsetY);
      apply();
      // Persister seulement si la position a réellement changé.
      if (Math.abs(ratio - getConfig().orbY) > 0.001) {
        setConfig({ orbY: ratio });
      }
    },
    dispose() {
      screen.removeListener("display-metrics-changed", onMetricsChanged);
    },
  };
}
