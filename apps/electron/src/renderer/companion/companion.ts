// The companion: sunflower poses + streamed answer bubble + voice.
import { ensureBridge } from "../shared/dev-stub";
import {
  BEE,
  CODING,
  MOOD_ART,
  POSES,
  READING,
  WORKING,
  pixelArtSvg,
  type PixelArt,
} from "../../shared/sunflower-pixels";
import type { ActivityContext, ActivitySnapshot } from "../../shared/activity";
import { ACTIVITY_CONTEXTS } from "../../shared/activity";
import type { CompanionPose, StatePayload } from "../../shared/state";
import { finish, initTts, pushText, stopTts } from "./tts";

ensureBridge();

const flower = document.getElementById("flower")!;
const flowerSvg = document.getElementById("flower-svg")!;
const bubble = document.getElementById("bubble")!;
const bubbleText = document.getElementById("bubble-text")!;
const stepBadge = document.getElementById("step-badge")!;

/* ~4.25 px per art pixel: the 1a flower is 51×38 for a 12×9 viewBox. */
const SCALE = 4.25;

/**
 * Les abeilles « thinking » : 2-3 petites abeilles pixel qui tournent autour
 * de la tête du tournesol. Construites une seule fois ; toute l'animation est
 * en CSS et ne tourne que lorsque #flower porte la classe .thinking (sinon
 * .bees est en display:none, donc aucune boucle/timer ne fuit hors de l'état).
 */
function buildBees(): void {
  const bees = document.createElement("div");
  bees.className = "bees";
  bees.setAttribute("aria-hidden", "true");
  const beeSvg = pixelArtSvg(BEE, 14, 11);
  for (let i = 1; i <= 3; i++) {
    const bee = document.createElement("span");
    bee.className = `bee bee-${i}`;
    const sprite = document.createElement("span");
    sprite.className = "bee-sprite";
    sprite.innerHTML = beeSvg;
    bee.appendChild(sprite);
    bees.appendChild(bee);
  }
  flower.appendChild(bees);
}

/** Pose → art. Les poses de base viennent de POSES ; les vignettes d'activité
    (coding/reading/working) sont des scènes dédiées. L'île garde ses propres
    petites icônes (ICONS), donc ces scènes plus larges ne concernent que le
    companion. */
const POSE_ART: Record<CompanionPose, PixelArt> = {
  idle: POSES.idle,
  listening: POSES.listening,
  thinking: POSES.thinking,
  answering: POSES.answering,
  pointing: POSES.pointing,
  coding: CODING,
  reading: READING,
  working: WORKING,
};

/** Poses dont l'animation est portée par une classe sur #flower : hors de cet
    état la classe disparaît, l'animation CSS s'arrête et aucun timer ne fuit. */
const ACTIVITY_CLASSES = ["coding", "reading", "working"] as const;

/* Après 60 s de pose « idle » SANS activité, toutes les animations décoratives
   infinies (balancement, curseur, accessoire d'humeur) sont mises en pause via
   body.anim-paused — gating ajouté suite à un rapport utilisateur « l'app fait
   chauffer mon ordinateur ». Tout changement d'état le lève aussitôt. */
const ANIM_PAUSE_AFTER_MS = 60_000;
/** Fréquence maximale de réarmement : le mousemove arrive à ~100 Hz. */
const ANIM_BUMP_MIN_MS = 1000;
let animPauseTimer: number | null = null;
let lastPose: CompanionPose = "idle";
let lastBumpAt = 0;

function armAnimPause(pose: CompanionPose): void {
  lastPose = pose;
  if (animPauseTimer !== null) {
    window.clearTimeout(animPauseTimer);
    animPauseTimer = null;
  }
  document.body.classList.remove("anim-paused");
  if (pose === "idle") {
    animPauseTimer = window.setTimeout(() => {
      document.body.classList.add("anim-paused");
    }, ANIM_PAUSE_AFTER_MS);
  }
}

/* Le compte de 60 s doit mesurer une vraie inactivité, pas le temps écoulé
   depuis le dernier changement d'état : sinon un accessoire d'humeur se fige
   au nez de quelqu'un qui est manifestement là. La fenêtre est traversée par
   la souris avec forward: true, donc elle voit passer les mousemove quand le
   curseur la survole — ce qui arrive constamment, la fenêtre suivant le
   curseur avec un temps de retard.
   Best-effort assumé : une activité au CLAVIER seul, ou le mode docké, ne
   réarment rien et le gel tombera quand même. C'est le bon sens du compromis
   — mieux vaut figer une décoration de trop que faire chauffer la machine,
   et le moindre changement d'état relance tout. */
function bumpAnimPause(): void {
  const now = performance.now();
  if (now - lastBumpAt < ANIM_BUMP_MIN_MS) return;
  lastBumpAt = now;
  armAnimPause(lastPose);
}

/* ── Humeurs contextuelles ─────────────────────────────────────────────
   Quand la fleur n'a RIEN à faire (pose idle), elle se donne un petit
   accessoire selon l'app au premier plan : casque sur Spotify, popcorn devant
   Netflix, plaid devant Figma… (voir shared/activity.ts et main/activity.ts).
   Deux règles strictes :
    - l'humeur ne s'affiche qu'à l'état idle. Dès qu'une session, un guide ou
      un agent reprend la main, la pose gagne — l'accessoire ne masque jamais
      un état réel ;
    - comme les vignettes d'activité, tout est en CSS sous une classe portée
      par #flower : hors de l'humeur, la classe part et l'animation s'arrête. */
let mood: ActivityContext = "none";
let pose: CompanionPose = "idle";

/** L'art réellement affiché : l'humeur quand on est au repos, sinon la pose. */
function currentArt(): PixelArt {
  if (pose === "idle") {
    const art = MOOD_ART[mood];
    if (art) return art;
  }
  return POSE_ART[pose];
}

function render(): void {
  const art = currentArt();
  const [vw, vh] = art.vb;
  flowerSvg.innerHTML = pixelArtSvg(
    art,
    Math.round(vw * SCALE),
    Math.round(vh * SCALE),
  );
  const moodOn = pose === "idle" && MOOD_ART[mood] !== null;
  // Le balancement reste réservé au tournesol nu : une scène d'humeur a sa
  // propre animation et n'a pas à tanguer en plus.
  flowerSvg.classList.toggle("sway", pose === "idle" && !moodOn);
  // Les abeilles n'apparaissent (et ne s'animent) qu'en état « thinking ».
  flower.classList.toggle("thinking", pose === "thinking");
  // Vignettes d'activité : une seule classe active à la fois.
  for (const cls of ACTIVITY_CLASSES) {
    flower.classList.toggle(cls, !moodOn && pose === cls);
  }
  // Humeurs : une seule classe `mood-*` active à la fois.
  for (const cls of ACTIVITY_CONTEXTS) {
    flower.classList.toggle(`mood-${cls}`, moodOn && mood === cls);
  }
  // Une humeur est décorative comme le reste : elle s'anime tant qu'on est là,
  // et se fige avec tout le monde après 60 s d'inactivité. Lui faire passer
  // « answering » ici désarmait le gel POUR TOUJOURS dès le premier accessoire.
  armAnimPause(pose);
}

function renderPose(next: CompanionPose): void {
  pose = next;
  render();
}

window.sunflower.onActivity((snapshot: ActivitySnapshot) => {
  if (snapshot.context === mood) return;
  mood = snapshot.context;
  render();
});

window.sunflower.onState((payload: StatePayload) => {
  renderPose(payload.pose);
  if (payload.island === "idle" || payload.island === "listening") {
    bubble.hidden = true;
    bubbleText.textContent = "";
    stepBadge.hidden = true;
    // No idle state may ever coexist with an active voice.
    if (payload.island === "idle") stopTts();
  }
});

window.sunflower.onAnswerReset(() => {
  bubbleText.textContent = "";
  bubble.hidden = true;
  stepBadge.hidden = true;
  stopTts();
});

window.sunflower.onAnswerToken((text) => {
  if (bubble.hidden) bubble.hidden = false;
  bubbleText.textContent = (bubbleText.textContent ?? "") + text;
  bubble.scrollTop = bubble.scrollHeight;
  pushText(text);
});

window.sunflower.onAnswerDone(() => {
  finish();
});

window.sunflower.onTtsStop(() => {
  stopTts();
});

// Étape de guide : la bulle est remplacée (pas ajoutée) et lue à voix haute.
window.sunflower.onGuideStep(({ index, total, text, cut }) => {
  if (cut) stopTts();
  bubble.hidden = false;
  stepBadge.hidden = false;
  stepBadge.textContent = `step ${index} of ${total}`;
  bubbleText.textContent = text;
  bubble.scrollTop = 0;
  pushText(text);
  finish();
});

window.sunflower.onFlip((side) => {
  document.body.classList.toggle("flip", side === "left");
});

// ── Dock : badge compact en bas à droite (voir main/windows/companion.ts) ──
window.sunflower.onCompanionDocked((docked) => {
  document.body.classList.toggle("docked", docked);
});

/* La fenêtre est traversée par la souris avec forward: true : les mousemove
   arrivent quand même ici. Au survol de la fleur, on demande au main de rendre
   la fenêtre interactive (le double-clic devient possible) ; on la relâche dès
   que le pointeur en sort pour ne jamais bloquer les clics du bureau. */
let overFlower = false;
const setHover = (next: boolean): void => {
  if (next === overFlower) return;
  overFlower = next;
  window.sunflower.companionSetHover(next);
};
document.addEventListener("mousemove", (e) => {
  bumpAnimPause();
  const r = flower.getBoundingClientRect();
  setHover(
    e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom,
  );
});
document.addEventListener("mouseleave", () => setHover(false));

// Double-clic sur la fleur : bascule follow ↔ docked (persisté en config).
flower.addEventListener("dblclick", () => {
  void window.sunflower.companionToggleDock();
});

initTts(() => window.sunflower.sendTtsEnded());
buildBees();
renderPose("idle");
