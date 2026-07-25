// Synthèse d'entrées macOS pour Sunflower Work, ZÉRO dépendance npm : on
// spawne /usr/bin/osascript. Les clics passent par JXA + pont ObjC qui poste
// de vrais CGEvents (CGEventCreateMouseEvent/CGEventPost sur kCGHIDEventTap)
// en COORDONNÉES GLOBALES EN POINTS (origine en haut à gauche de l'écran
// principal — exactement le repère des displays Electron, PAS les pixels de
// la capture). La frappe passe par System Events (keystroke/keyCode).
// Chaque salve est encadrée par beginSelfInput() pour que la garde de
// présence (presence.ts) ne prenne pas nos propres événements pour un
// retour de l'utilisateur. Tout process en vol est tuable via cancelClicker.
import { execFile, type ChildProcess } from "node:child_process";
import { beginSelfInput, type InputKind } from "../presence";

/** Erreur porteuse d'un message montrable tel quel (île/notification). */
export class ClickerError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

const MOUSE_TIMEOUT_MS = 10_000;
const TYPE_TIMEOUT_MS = 30_000;
/** Frappe bornée : au-delà, c'est que le modèle divague. */
const MAX_TYPE_CHARS = 500;
/** La frappe part en tranches courtes : entre deux tranches, la garde de
 *  présence clavier se réarme, donc un utilisateur qui se met à taper est
 *  détecté en une seconde au lieu d'à la fin d'une salve de 500 caractères. */
const TYPE_CHUNK_CHARS = 40;

const children = new Set<ChildProcess>();

/**
 * JXA : poste move + N clics gauches en CGEvents sur le tap HID.
 * Constantes CG en clair (les enums ne sont pas exposés par le pont ObjC) :
 * 5 = kCGEventMouseMoved, 1/2 = kCGEventLeftMouseDown/Up,
 * dernier 0 de CGEventCreateMouseEvent = kCGMouseButtonLeft,
 * champ 1 = kCGMouseEventClickState, tap 0 = kCGHIDEventTap.
 */
const MOUSE_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "function run(argv) {",
  "  var x = parseFloat(argv[0]);",
  "  var y = parseFloat(argv[1]);",
  "  var clicks = parseInt(argv[2], 10);",
  "  function post(type, state) {",
  "    var e = $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, 0);",
  "    if (state > 0) $.CGEventSetIntegerValueField(e, 1, state);",
  "    $.CGEventPost(0, e);",
  "  }",
  "  post(5, 0);",
  "  delay(0.08);",
  "  for (var i = 1; i <= clicks; i++) {",
  "    post(1, i);",
  "    delay(0.04);",
  "    post(2, i);",
  "    if (i < clicks) delay(0.12);",
  "  }",
  "}",
].join("\n");

/** JXA : frappe du texte reçu en argument (jamais interpolé dans le script). */
const TYPE_SCRIPT =
  "function run(argv) { Application('System Events').keystroke(argv[0]); }";

/** JXA : appui d'une touche par keyCode System Events. */
const KEY_SCRIPT =
  "function run(argv) { Application('System Events').keyCode(parseInt(argv[0], 10)); }";

/** Touches nommées acceptées de la part du modèle → keyCodes macOS.
 *  Les quatre dernières servent au défilement : pas de molette synthétique
 *  (elle demanderait un binaire natif), mais page down / page up marchent
 *  partout et restent annulables comme le reste. */
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
  return runOsa(MOUSE_SCRIPT, [fmt(x), fmt(y), "1"], MOUSE_TIMEOUT_MS, "mouse");
}

/** Double-clic gauche en (x, y) — POINTS globaux. */
export function doubleClickAt(x: number, y: number): Promise<void> {
  return runOsa(MOUSE_SCRIPT, [fmt(x), fmt(y), "2"], MOUSE_TIMEOUT_MS, "mouse");
}

/** Frappe le texte dans l'élément qui a le focus (System Events), en
 *  tranches courtes pour que la garde de présence se réarme entre deux.
 *
 *  `shouldStop` est consulté ENTRE deux tranches : c'est exactement la fenêtre
 *  où un vrai appui de touche est visible (pendant une tranche, la famille
 *  clavier est masquée pour ne pas confondre notre frappe avec la sienne).
 *  L'utilisateur s'est remis à taper → on s'arrête là, quitte à laisser un
 *  texte incomplet : mieux vaut ça que d'écrire dans le champ qu'il vient de
 *  choisir. Le run repart d'une capture neuve et voit ce qui a été tapé. */
export async function typeText(
  text: string,
  shouldStop?: () => boolean,
): Promise<void> {
  const t = text.slice(0, MAX_TYPE_CHARS);
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

/** Tue tout osascript en vol (abandon instantané d'un run de travail). */
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
