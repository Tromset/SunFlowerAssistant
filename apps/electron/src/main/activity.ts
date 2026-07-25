// Détection de l'activité courante : quelle app est au premier plan et, si
// c'est un navigateur pilotable, quel site est ouvert. Sert UNIQUEMENT à
// donner un petit accessoire au tournesol (casque, popcorn, plaid…) — voir
// shared/activity.ts pour le classement et renderer/companion pour le rendu.
//
// Trois promesses, dans cet ordre :
//  1. 100 % local — aucune de ces informations ne quitte la machine, rien
//     n'est écrit sur disque, rien n'est envoyé au modèle.
//  2. Discret — un osascript toutes les quelques secondes, en pause dès que
//     personne ne regarde (compagnon masqué, utilisateur parti, opt-out).
//  3. Silencieux — jamais d'exception : une observation ratée rend « none ».
import { execFile, type ChildProcess } from "node:child_process";
import {
  classifyActivity,
  type ActivityContext,
  type ActivitySnapshot,
} from "../shared/activity";

/** Cadence normale : assez lent pour être invisible côté CPU, assez vif pour
 *  que l'accessoire suive un changement d'app. */
const POLL_MS = 4000;
/** Cadence ralentie quand l'utilisateur ne touche plus rien : la scène ne
 *  bouge plus, inutile de la re-sonder au même rythme. */
const IDLE_POLL_MS = 20_000;
/** Inactivité au-delà de laquelle on passe en cadence ralentie. */
const IDLE_AFTER_MS = 60_000;
/** Budget d'un aller-retour osascript (spawn + AppleEvents). */
const PROBE_TIMEOUT_MS = 2000;

// JXA : nom de l'app au premier plan et, pour un navigateur pilotable, l'URL
// de l'onglet actif. Toute erreur (Automation refusée, fenêtre absente) est
// absorbée : on rend au moins le nom de l'app.
const PROBE_SCRIPT = [
  "function run() {",
  "  var procs = Application('System Events').applicationProcesses.whose({ frontmost: true });",
  "  if (procs.length === 0) return '{}';",
  "  var name = procs[0].name();",
  "  var chromiums = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge', 'Arc', 'Dia', 'Vivaldi', 'Opera', 'Orion'];",
  "  var url = '';",
  "  try {",
  "    if (name === 'Safari' || name === 'Safari Technology Preview') {",
  "      url = Application(name).windows[0].currentTab.url();",
  "    } else if (chromiums.indexOf(name) !== -1) {",
  "      url = Application(name).windows[0].activeTab.url();",
  "    }",
  "  } catch (e) {",
  "    url = '';",
  "  }",
  "  return JSON.stringify({ app: name, url: url || '' });",
  "}",
].join("\n");

/** Sortie brute du script → {app, url}. Exporté pour les tests. */
export function parseProbe(raw: string): { app: string; url: string } | null {
  try {
    const data = JSON.parse(raw.trim()) as { app?: unknown; url?: unknown };
    if (typeof data.app !== "string" || !data.app) return null;
    return { app: data.app, url: typeof data.url === "string" ? data.url : "" };
  } catch {
    return null;
  }
}

const NONE: ActivitySnapshot = { context: "none", app: "", host: "" };

export interface ActivityWatcher {
  /** Dernière observation connue (jamais null). */
  current(): ActivitySnapshot;
  /** Suspend/reprend le sondage — appelé quand le compagnon se cache, quand
   *  une session vocale prend la main, ou quand l'utilisateur coupe l'option. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export interface ActivityWatcherDeps {
  /** Nouvelle famille détectée (jamais rappelé pour une famille identique). */
  onChange(snapshot: ActivitySnapshot): void;
  /** Millisecondes depuis la dernière entrée réelle (voir presence.ts). */
  idleMs(): number;
  /** Injectable pour les tests ; par défaut, l'osascript ci-dessus. */
  probe?(): Promise<{ app: string; url: string } | null>;
}

/** Sonde macOS par défaut. Hors macOS : rien à observer. */
function osascriptProbe(): Promise<{ app: string; url: string } | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = execFile(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", PROBE_SCRIPT],
        { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" },
        (err, stdout) => {
          resolve(err ? null : parseProbe(stdout));
        },
      );
    } catch {
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
  });
}

export function createActivityWatcher(
  deps: ActivityWatcherDeps,
): ActivityWatcher {
  const probe = deps.probe ?? osascriptProbe;
  let snapshot: ActivitySnapshot = NONE;
  let enabled = false;
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let timerMs = 0;
  /** Un sondage est en vol : ne jamais en empiler deux. */
  let inFlight = false;

  const setTimer = (ms: number | null) => {
    if (ms === null) {
      if (timer) clearTimeout(timer);
      timer = null;
      timerMs = 0;
      return;
    }
    if (timer && timerMs === ms) return;
    if (timer) clearTimeout(timer);
    timerMs = ms;
    timer = setTimeout(tick, ms);
  };

  const emit = (next: ActivitySnapshot) => {
    // Seul un changement de FAMILLE compte : passer d'un onglet YouTube à un
    // autre ne doit pas refaire clignoter le popcorn.
    const changed = next.context !== snapshot.context;
    snapshot = next;
    if (changed) deps.onChange(next);
  };

  async function tick(): Promise<void> {
    timer = null;
    timerMs = 0;
    if (disposed || !enabled || inFlight) return;
    inFlight = true;
    try {
      const observed = await probe();
      if (disposed || !enabled) return;
      emit(
        observed
          ? classifyActivity(observed.app, observed.url)
          : NONE,
      );
    } catch {
      // Jamais bruyant : une sonde ratée ne change rien à l'accessoire.
    } finally {
      inFlight = false;
      if (!disposed && enabled) {
        setTimer(deps.idleMs() >= IDLE_AFTER_MS ? IDLE_POLL_MS : POLL_MS);
      }
    }
  }

  return {
    current: () => snapshot,
    setEnabled(next) {
      if (disposed || enabled === next) return;
      enabled = next;
      if (next) {
        // Reprise : sonder tout de suite, l'app au premier plan a pu changer
        // pendant la pause.
        void tick();
      } else {
        setTimer(null);
        // Repartir de zéro : au retour, la famille sera rediffusée même si
        // elle est identique à celle d'avant la pause.
        if (snapshot.context !== "none") {
          snapshot = NONE;
          deps.onChange(NONE);
        }
      }
    },
    dispose() {
      disposed = true;
      enabled = false;
      setTimer(null);
    },
  };
}

/** Ré-export pratique pour les consommateurs main (index.ts). */
export type { ActivityContext, ActivitySnapshot };
