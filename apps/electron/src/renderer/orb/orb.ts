// Orb: mini sunflower badge docked to the right edge, shown while a
// Sunflower-Code session or a Sunflower Work run is busy. Hover expands a
// status pill; a vertical drag repositions it; a plain click opens the app
// the badge is currently showing.
import { ensureBridge } from "../shared/dev-stub";
import { POSES, pixelArtSvg } from "../../shared/sunflower-pixels";
import type { OrbRun } from "../../shared/orb";

ensureBridge();

const dock = document.getElementById("dock")!;
const orb = document.getElementById("orb")!;
const orbIcon = document.getElementById("orb-icon")!;
const pillTitle = document.getElementById("pill-title")!;
const pillState = document.getElementById("pill-state")!;

// Petite fleur pixel au centre du disque (8×9 → ~24×27).
orbIcon.innerHTML = pixelArtSvg(POSES.idle, 24, 27);

/** Source du run affiché : le clic ouvre l'app correspondante. */
let currentSource: OrbRun["source"] = "code";

function renderStatus(runs: OrbRun[]): void {
  const active = runs.filter((r) => r.active);
  dock.classList.toggle("active", active.length > 0);
  // Le texte est déjà rédigé par le main : on choisit seulement lequel
  // montrer — celui qui travaille vraiment, sinon le premier actif.
  const current = runs.find((r) => r.working) ?? active[0] ?? runs[0];
  if (!current) {
    pillTitle.textContent = "sunflower";
    pillState.textContent = "idle";
    orb.title = "sunflower";
    dock.classList.remove("working");
    return;
  }
  currentSource = current.source;
  // Les autres runs en cours sont résumés en un mot : la pastille n'a la
  // place que d'une ligne d'état.
  const others = active.filter((r) => r.id !== current.id).length;
  pillTitle.textContent = current.title;
  pillState.textContent =
    others > 0 ? `${current.state} · ${others} more` : current.state;
  orb.title = `${current.title} — ${current.state}`;
  dock.classList.toggle("working", current.working);
}

// ---- Survol : demande à main d'élargir la fenêtre pour la pastille --------
let dragging = false;

orb.addEventListener("mouseenter", () => {
  dock.classList.add("expanded");
  window.sunflower.orbHoverStart();
});
orb.addEventListener("mouseleave", () => {
  if (dragging) return; // garder la pastille pendant un glisser
  dock.classList.remove("expanded");
  window.sunflower.orbHoverEnd();
});

// ---- Glisser vertical (reposition) vs clic (ouvre le panneau) -------------
const DRAG_THRESHOLD = 3;
let moved = false;
let startY = 0;

orb.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  startY = e.screenY;
  window.sunflower.orbDragStart(e.screenY);
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  if (Math.abs(e.screenY - startY) > DRAG_THRESHOLD) moved = true;
  window.sunflower.orbDragMove(e.screenY);
});
window.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  window.sunflower.orbDragEnd(e.screenY);
  if (!moved) {
    // Clic franc : ouvrir l'app du run affiché.
    void window.sunflower.orbOpen(currentSource);
  } else if (!orb.matches(":hover")) {
    // Relâché hors du disque : replier.
    dock.classList.remove("expanded");
    window.sunflower.orbHoverEnd();
  }
});

window.sunflower.onOrbChanged(renderStatus);

// La fenêtre est ré-affichée repliée par main (show/hide) : abandonner tout
// état de survol/glisser d'une vie antérieure pour rester synchrone.
window.sunflower.onOrbReset(() => {
  dragging = false;
  moved = false;
  dock.classList.remove("expanded");
});
