// Synthèse d'entrées macOS pour Sunflower Work, ZÉRO dépendance npm : on
// spawne /usr/bin/osascript. Les gestes de souris passent par JXA + pont ObjC
// qui poste de vrais CGEvents (CGEventCreateMouseEvent / …ScrollWheelEvent2,
// CGEventPost sur kCGHIDEventTap) en COORDONNÉES GLOBALES EN POINTS (origine
// en haut à gauche de l'écran principal — exactement le repère des displays
// Electron, PAS les pixels de la capture). La frappe passe par System Events
// (keystroke/keyCode), avec ou sans modificateurs.
//
// Chaque salve est encadrée par beginSelfInput() pour que la garde de
// présence (presence.ts) ne prenne pas nos propres événements pour un
// retour de l'utilisateur. Tout process en vol est tuable via cancelClicker.
//
// Le texte, les noms de touche et les cibles voyagent TOUJOURS en argv : rien
// n'est interpolé dans un script, jamais.
import { execFile, type ChildProcess } from "node:child_process";
import { clipboard } from "electron";
import { beginSelfInput, type InputKind } from "../presence";
import { resolveOpenTarget } from "./open-guard";

/** Erreur porteuse d'un message montrable tel quel (île/notification). */
export class ClickerError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

const MOUSE_TIMEOUT_MS = 10_000;
const TYPE_TIMEOUT_MS = 30_000;
/** Un glisser bouge en une quinzaine de sauts espacés : plus long qu'un clic. */
const DRAG_TIMEOUT_MS = 20_000;
/** `open` rend la main tout de suite ; le lancement se poursuit sans nous. */
const OPEN_TIMEOUT_MS = 15_000;
/** Frappe bornée : au-delà, c'est que le modèle divague. */
const MAX_TYPE_CHARS = 500;
/** La frappe part en tranches courtes : entre deux tranches, la garde de
 *  présence clavier se réarme, donc un utilisateur qui se met à taper est
 *  détecté en une seconde au lieu d'à la fin d'une salve de 500 caractères. */
const TYPE_CHUNK_CHARS = 40;
/** Crans de molette par défaut, et plafond (le modèle demande parfois 500). */
const SCROLL_DEFAULT_CLICKS = 5;
const SCROLL_MAX_CLICKS = 20;
/** Lignes défilées par cran — l'ordre de grandeur d'une molette physique. */
const SCROLL_LINES_PER_CLICK = 3;

const children = new Set<ChildProcess>();

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * JXA : poste move + N clics sur le tap HID.
 * Constantes CG en clair (les enums ne sont pas exposés par le pont ObjC) :
 * 5 = kCGEventMouseMoved, 1/2 = kCGEventLeftMouseDown/Up,
 * 3/4 = kCGEventRightMouseDown/Up, dernier argument de
 * CGEventCreateMouseEvent = le bouton (0 = gauche, 1 = droit),
 * champ 1 = kCGMouseEventClickState, tap 0 = kCGHIDEventTap.
 * Les types d'événement et le bouton arrivent en argv : un seul script pour
 * le clic gauche, le double-clic et le clic droit.
 */
const MOUSE_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "function run(argv) {",
  "  var x = parseFloat(argv[0]);",
  "  var y = parseFloat(argv[1]);",
  "  var clicks = parseInt(argv[2], 10);",
  "  var down = parseInt(argv[3], 10);",
  "  var up = parseInt(argv[4], 10);",
  "  var button = parseInt(argv[5], 10);",
  "  function post(type, state) {",
  "    var e = $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, button);",
  "    if (state > 0) $.CGEventSetIntegerValueField(e, 1, state);",
  "    $.CGEventPost(0, e);",
  "  }",
  "  post(5, 0);",
  "  delay(0.08);",
  "  for (var i = 1; i <= clicks; i++) {",
  "    post(down, i);",
  "    delay(0.04);",
  "    post(up, i);",
  "    if (i < clicks) delay(0.12);",
  "  }",
  "}",
].join("\n");

/**
 * JXA : presser, traîner, relâcher. 6 = kCGEventLeftMouseDragged.
 * Le trajet est interpolé en une quinzaine de points : macOS et les apps
 * Cocoa ignorent un « saut » instantané entre le down et le up — sans les
 * points intermédiaires, rien n'est déplacé.
 */
const DRAG_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "function run(argv) {",
  "  var x1 = parseFloat(argv[0]);",
  "  var y1 = parseFloat(argv[1]);",
  "  var x2 = parseFloat(argv[2]);",
  "  var y2 = parseFloat(argv[3]);",
  "  var steps = 15;",
  "  function post(type, x, y) {",
  "    $.CGEventPost(0, $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, 0));",
  "  }",
  "  post(5, x1, y1);",
  "  delay(0.08);",
  "  post(1, x1, y1);",
  "  delay(0.12);",
  "  for (var i = 1; i <= steps; i++) {",
  "    var t = i / steps;",
  "    post(6, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);",
  "    delay(0.02);",
  "  }",
  "  delay(0.12);",
  "  post(2, x2, y2);",
  "}",
].join("\n");

/**
 * JXA : molette réelle, sous le curseur placé au préalable (macOS livre le
 * défilement à la fenêtre survolée, pas à celle qui a le focus).
 *
 * On passe par CGEventCreateScrollWheelEvent2 et pas par son aîné : la
 * première est VARIADIQUE, et le pont ObjC de JXA ne sait pas appeler une
 * variadique de façon fiable. La « 2 » prend six arguments fixes
 * (source, unités, nombre d'axes, axe1, axe2, axe3) et passe donc sans
 * binaire natif — contrairement à ce que disait le commentaire d'origine,
 * qui avait fait renoncer à la molette au profit de page down / page up.
 * 1 = kCGScrollEventUnitLine ; axe 1 = vertical (positif = vers le haut),
 * axe 2 = horizontal.
 */
const SCROLL_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "function run(argv) {",
  "  var x = parseFloat(argv[0]);",
  "  var y = parseFloat(argv[1]);",
  "  var dy = parseInt(argv[2], 10);",
  "  var dx = parseInt(argv[3], 10);",
  "  var clicks = parseInt(argv[4], 10);",
  "  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, { x: x, y: y }, 0));",
  "  delay(0.08);",
  "  for (var i = 0; i < clicks; i++) {",
  "    $.CGEventPost(0, $.CGEventCreateScrollWheelEvent2($(), 1, 2, dy, dx, 0));",
  "    delay(0.05);",
  "  }",
  "}",
].join("\n");

/** JXA : frappe du texte reçu en argument (jamais interpolé dans le script). */
const TYPE_SCRIPT =
  "function run(argv) { Application('System Events').keystroke(argv[0]); }";

/** JXA : appui d'une touche par keyCode System Events. */
const KEY_SCRIPT =
  "function run(argv) { Application('System Events').keyCode(parseInt(argv[0], 10)); }";

/**
 * JXA : une combinaison. argv[0] dit si la cible est un caractère ou un
 * keyCode, argv[1] la porte, et tout le reste est la liste des modificateurs
 * — construite ici à partir d'argv, jamais écrite dans le script.
 */
const HOTKEY_SCRIPT = [
  "function run(argv) {",
  "  var mods = argv.slice(2);",
  "  var se = Application('System Events');",
  "  var opts = mods.length > 0 ? { using: mods } : {};",
  "  if (argv[0] === 'code') se.keyCode(parseInt(argv[1], 10), opts);",
  "  else se.keystroke(argv[1], opts);",
  "}",
].join("\n");

/** Touches nommées acceptées de la part du modèle → keyCodes macOS. */
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  space: 49,
  delete: 51,
  backspace: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  pagedown: 121,
  pageup: 116,
  home: 115,
  end: 119,
};

/** Noms de touches acceptés, pour le prompt du modèle et la documentation. */
export const KEY_NAMES: readonly string[] = Object.keys(KEY_CODES);

/** Modificateurs acceptés → vocabulaire System Events. */
const MODIFIERS: Record<string, string> = {
  cmd: "command down",
  command: "command down",
  meta: "command down",
  ctrl: "control down",
  control: "control down",
  opt: "option down",
  option: "option down",
  alt: "option down",
  shift: "shift down",
};

function runOsa(
  script: string,
  args: string[],
  timeoutMs: number,
  kind: InputKind,
): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.reject(
      new ClickerError("sunflower work only knows how to drive macOS."),
    );
  }
  return new Promise((resolve, reject) => {
    // Fenêtre « entrées synthétiques » ouverte AVANT le spawn : les CGEvents
    // partent dès que le process démarre. Seule la famille concernée est
    // masquée à la garde de présence : pendant une frappe, un mouvement de
    // souris RÉEL annule toujours le run (et inversement).
    const endSelf = beginSelfInput(kind);
    const child = execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, ...args],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (err, _stdout, stderr) => {
        children.delete(child);
        endSelf();
        if (!err) {
          resolve();
          return;
        }
        const detail = (stderr || err.message || "").trim();
        // 1002 = errAEEventNotPermitted (System Events sans Accessibilité).
        if (/assistive|accessibility|not authori[sz]ed|-?1002/i.test(detail)) {
          reject(
            new ClickerError(
              "macOS refused the synthetic input — grant Accessibility to sunflower in the panel, then try again.",
            ),
          );
        } else if (err.killed) {
          reject(new ClickerError("the input helper was stopped."));
        } else {
          reject(
            new ClickerError(
              `input failed: ${detail.slice(0, 140) || "unknown osascript error"}`,
            ),
          );
        }
      },
    );
    children.add(child);
  });
}

const fmt = (n: number) => n.toFixed(1);

/** Déplace la souris puis clique en (x, y) — POINTS globaux. */
export function clickAt(x: number, y: number): Promise<void> {
  return runOsa(
    MOUSE_SCRIPT,
    [fmt(x), fmt(y), "1", "1", "2", "0"],
    MOUSE_TIMEOUT_MS,
    "mouse",
  );
}

/** Double-clic gauche en (x, y) — POINTS globaux. */
export function doubleClickAt(x: number, y: number): Promise<void> {
  return runOsa(
    MOUSE_SCRIPT,
    [fmt(x), fmt(y), "2", "1", "2", "0"],
    MOUSE_TIMEOUT_MS,
    "mouse",
  );
}

/** Clic droit en (x, y) : le menu contextuel, c'est-à-dire la moitié de ce
 *  qu'on sait faire d'un Finder ou d'une page web. */
export function rightClickAt(x: number, y: number): Promise<void> {
  return runOsa(
    MOUSE_SCRIPT,
    [fmt(x), fmt(y), "1", "3", "4", "1"],
    MOUSE_TIMEOUT_MS,
    "mouse",
  );
}

/** Presse en (x1, y1) et relâche en (x2, y2) — POINTS globaux. */
export function dragTo(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  return runOsa(
    DRAG_SCRIPT,
    [fmt(x1), fmt(y1), fmt(x2), fmt(y2)],
    DRAG_TIMEOUT_MS,
    "mouse",
  );
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export function isScrollDirection(value: string): value is ScrollDirection {
  return (
    value === "up" || value === "down" || value === "left" || value === "right"
  );
}

/**
 * Molette sous (x, y). `clicks` est borné : le modèle demande volontiers 200.
 *
 * Repli assumé : si le pont ObjC refuse ScrollWheelEvent2 sur une version de
 * macOS où il se comporte autrement qu'attendu, on retombe sur page down /
 * page up — l'ancien comportement. Le geste se dégrade, il n'échoue pas.
 */
export async function scrollAt(
  x: number,
  y: number,
  direction: ScrollDirection,
  clicks = SCROLL_DEFAULT_CLICKS,
): Promise<void> {
  const count = Math.min(
    SCROLL_MAX_CLICKS,
    Math.max(1, Math.round(Number.isFinite(clicks) ? clicks : SCROLL_DEFAULT_CLICKS)),
  );
  const lines = SCROLL_LINES_PER_CLICK;
  // Axe vertical positif = vers le haut du document.
  const dy = direction === "up" ? lines : direction === "down" ? -lines : 0;
  const dx = direction === "left" ? lines : direction === "right" ? -lines : 0;
  try {
    await runOsa(
      SCROLL_SCRIPT,
      [fmt(x), fmt(y), String(dy), String(dx), String(count)],
      MOUSE_TIMEOUT_MS,
      "mouse",
    );
  } catch (err) {
    if (direction === "left" || direction === "right") throw err;
    await pressKey(direction === "up" ? "pageup" : "pagedown");
  }
}

export interface Hotkey {
  /** Une touche nommée (keyCode) ou un caractère. */
  kind: "code" | "char";
  value: string;
  /** Vocabulaire System Events, déjà traduit. */
  modifiers: string[];
}

/**
 * Lit « cmd+shift+t » — exporté pour être testable, comme parseStep.
 *
 * Au moins un modificateur est exigé : sans lui, c'est `key` qu'il fallait
 * demander, et laisser passer les deux formes brouillerait la grammaire que
 * le modèle doit tenir. Null = combinaison refusée.
 */
export function parseHotkey(raw: string): Hotkey | null {
  const parts = raw
    .trim()
    .toLowerCase()
    .split(/[+\s]+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIERS[part];
    if (mod === undefined) return null;
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  if (modifiers.length === 0) return null;
  const code = KEY_CODES[last];
  if (code !== undefined) return { kind: "code", value: String(code), modifiers };
  if (/^[a-z0-9`\-=[\]\\;',./]$/.test(last)) {
    return { kind: "char", value: last, modifiers };
  }
  return null;
}

/** Joue une combinaison : ⌘C, ⌘V, ⌘A, ⌘F, ⌘L, ⌘T, ⌘W, ⌘⇧T… */
export function pressHotkey(combo: string): Promise<void> {
  const parsed = parseHotkey(combo);
  if (!parsed) {
    return Promise.reject(
      new ClickerError(
        `"${combo.slice(0, 24)}" isn't a combination I can press — try cmd+c, cmd+shift+t…`,
      ),
    );
  }
  return runOsa(
    HOTKEY_SCRIPT,
    [parsed.kind, parsed.value, ...parsed.modifiers],
    MOUSE_TIMEOUT_MS,
    "keyboard",
  );
}

/**
 * Colle `text` par le presse-papiers plutôt que de le frapper.
 *
 * Frapper 500 caractères, c'est treize spawns d'osascript et autant de
 * secondes ; un ⌘V, c'est un seul geste. Le contenu précédent est remis en
 * place derrière — avec sa limite, dite ici plutôt que cachée : readText() ne
 * retient que du texte brut, donc une image ou du texte riche qui était dans
 * le presse-papiers ne survit pas au collage.
 */
export async function pasteText(text: string): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);
  try {
    await pressHotkey("cmd+v");
    // Laisser l'app consommer le presse-papiers avant de le rendre.
    await pause(300);
  } finally {
    clipboard.writeText(previous);
  }
}

/** Frappe le texte dans l'élément qui a le focus.
 *
 *  Court : System Events, en tranches, pour que la garde de présence se
 *  réarme entre deux. `shouldStop` est consulté ENTRE deux tranches — c'est
 *  exactement la fenêtre où un vrai appui de touche est visible (pendant une
 *  tranche, la famille clavier est masquée pour ne pas confondre notre frappe
 *  avec la sienne). L'utilisateur s'est remis à taper → on s'arrête là, quitte
 *  à laisser un texte incomplet : mieux vaut ça que d'écrire dans le champ
 *  qu'il vient de choisir. Le run repart d'une capture neuve et voit ce qui a
 *  été tapé.
 *
 *  Long : un collage, qui est atomique. On n'y gagne pas que de la vitesse —
 *  une frappe longue est aussi ce qui a le plus de chances d'être coupée en
 *  deux par un retour de l'utilisateur. */
export async function typeText(
  text: string,
  shouldStop?: () => boolean,
): Promise<void> {
  const t = text.slice(0, MAX_TYPE_CHARS);
  if (!t) return;
  if (t.length > TYPE_CHUNK_CHARS) {
    try {
      await pasteText(t);
      return;
    } catch {
      // Presse-papiers ou ⌘V indisponible : on frappe, comme avant.
    }
  }
  for (let i = 0; i < t.length; i += TYPE_CHUNK_CHARS) {
    if (i > 0 && shouldStop?.()) return;
    await runOsa(
      TYPE_SCRIPT,
      [t.slice(i, i + TYPE_CHUNK_CHARS)],
      TYPE_TIMEOUT_MS,
      "keyboard",
    );
  }
}

/** Appuie une touche nommée (return, tab, escape, space, delete, flèches). */
export function pressKey(name: string): Promise<void> {
  const code = KEY_CODES[name.trim().toLowerCase()];
  if (code === undefined) {
    return Promise.reject(
      new ClickerError(`unknown key "${name.slice(0, 20)}".`),
    );
  }
  return runOsa(KEY_SCRIPT, [String(code)], MOUSE_TIMEOUT_MS, "keyboard");
}

/**
 * Ouvre une app ou une page — le seul geste dont l'effet dépasse le pixel
 * visé, d'où le filtre de open-guard.ts en amont. Pas d'osascript ici, pas de
 * shell non plus : /usr/bin/open reçoit ses arguments en argv, point.
 *
 * Rend le libellé de ce qui a été ouvert, pour le journal.
 */
export function openOnDesktop(target: string): Promise<string> {
  const resolved = resolveOpenTarget(target);
  if (resolved.kind === "blocked") {
    return Promise.reject(new ClickerError(resolved.reason));
  }
  if (process.platform !== "darwin") {
    return Promise.reject(
      new ClickerError("sunflower work only knows how to drive macOS."),
    );
  }
  const args = resolved.kind === "app" ? ["-a", resolved.name] : [resolved.url];
  const label = resolved.kind === "app" ? resolved.name : resolved.url;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/open",
      args,
      { timeout: OPEN_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, _stdout, stderr) => {
        children.delete(child);
        if (!err) {
          resolve(label);
          return;
        }
        const detail = (stderr || err.message || "").trim();
        reject(
          new ClickerError(
            `couldn't open ${label.slice(0, 60)}: ${detail.slice(0, 120) || "unknown error"}`,
          ),
        );
      },
    );
    children.add(child);
  });
}

/** Tue tout process en vol (abandon instantané d'un run de travail). */
export function cancelClicker(): void {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // déjà terminé
    }
  }
  children.clear();
}
