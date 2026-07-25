// Détection de l'activité courante : quelle app est au premier plan et, si
// c'est un navigateur pilotable, quel site est ouvert. Sert UNIQUEMENT à
// donner un petit accessoire au tournesol (casque, popcorn, plaid…) — voir
// shared/activity.ts pour le classement et renderer/companion pour le rendu.
//
// ÉVÉNEMENTIEL, PAS DE SONDAGE. Ce module a d'abord été écrit avec un
// `osascript` relancé toutes les 4 secondes qui interrogeait
// `System Events → applicationProcesses.whose({frontmost:true})` : ~900
// processus forkés par heure, chacun énumérant toutes les apps de la machine
// par Apple Events, et l'Automatisation exigée par-dessus. C'était la
// quatrième version du même bug dans ce repo (« l'app fait chauffer mon
// ordinateur ») — voir le budget always-on dans CLAUDE.md.
//
// Ce qui l'a remplacé :
//  1. `systemPreferences.subscribeWorkspaceNotification` : Electron sait
//     s'abonner à NSWorkspaceDidActivateApplicationNotification DANS le
//     process principal. Aucun sous-processus, aucune boucle, aucune
//     permission. Au repos, ça ne coûte rien du tout ;
//  2. le nom localisé de l'app demande encore un aller-retour — mais un seul
//     par bundle INCONNU : le cache bundle → nom fait que revenir sur une app
//     déjà vue ne coûte plus rien. Et la sonde passe par NSWorkspace, pas par
//     System Events : ni Accessibilité ni Automatisation ;
//  3. l'URL de l'onglet n'a aucune notification système : elle est relue sur
//     ENTRÉE RÉELLE (presence.ts), throttlée, et seulement quand un navigateur
//     est au premier plan. Naviguer demande un clic ou une frappe, donc on ne
//     rate pas de changement de site — et quand personne ne touche à rien,
//     rien ne part.
//
// Trois promesses, inchangées :
//  1. 100 % local — rien n'est écrit sur disque, rien n'est envoyé au modèle.
//  2. Discret — aucun travail périodique, tout s'arrête dès que personne ne
//     regarde (compagnon masqué, opt-out).
//  3. Silencieux — jamais d'exception, jamais une ligne dans le terminal : une
//     observation ratée garde simplement l'accessoire précédent.
import { systemPreferences } from "electron";
import { execFile, type ChildProcess } from "node:child_process";
import { onRealInput } from "./presence";
import {
  classifyActivity,
  type ActivityContext,
  type ActivitySnapshot,
} from "../shared/activity";

/** Notification macOS : une app vient de passer au premier plan. */
const ACTIVATED = "NSWorkspaceDidActivateApplicationNotification";
/** Clé de l'app dans le userInfo de cette notification. */
const APP_KEY = "NSWorkspaceApplicationKey";

/** Une app qui démarre s'active parfois deux fois de suite : on laisse retomber. */
const ACTIVATION_DEBOUNCE_MS = 200;
/** Écart minimal entre deux lectures d'URL, même si l'utilisateur pianote. */
const URL_MIN_GAP_MS = 10_000;
/** Délai avant de lire l'URL après une entrée : un clic sur un lien doit avoir
 *  le temps d'aboutir, sinon on relit l'ANCIENNE page et on n'y revient jamais. */
const URL_SETTLE_MS = 1200;
/** Budget d'un aller-retour osascript (spawn + éventuel AppleEvent). */
const PROBE_TIMEOUT_MS = 2500;
/** Échecs consécutifs au-delà desquels on renonce pour la session. Sans cette
 *  borne, un environnement cassé produirait un spawn par changement d'app,
 *  indéfiniment — c'est-à-dire le même bug sous un autre nom. */
const MAX_HARD_FAILURES = 5;
/** Plafond du cache bundle → nom (une machine n'a pas 32 apps au premier plan). */
const NAME_CACHE_MAX = 32;

/** Navigateurs dont on sait lire l'onglet actif. */
const SAFARIS = ["Safari", "Safari Technology Preview"];
const CHROMIUMS = [
  "Google Chrome",
  "Google Chrome Canary",
  "Chromium",
  "Brave Browser",
  "Microsoft Edge",
  "Arc",
  "Dia",
  "Vivaldi",
  "Opera",
  "Orion",
];
const BROWSERS = new Set([...SAFARIS, ...CHROMIUMS]);

/** L'app au premier plan expose-t-elle son onglet actif ? Lookup O(1) : ce
 *  test est sur le chemin des entrées globales, appelé ~100 fois/seconde. */
function isScriptableBrowser(app: string): boolean {
  return BROWSERS.has(app);
}

/** Automatisation refusée pour cette app : inutile de redemander à chaque fois. */
function isAutomationDenied(err: string): boolean {
  return /-1743|not authoriz|Automation/i.test(err);
}

// JXA : nom + bundle de l'app au premier plan via NSWorkspace — SANS Apple
// Event et SANS permission, contrairement à System Events. L'URL de l'onglet,
// elle, demande un vrai Apple Event : envoyé au SEUL navigateur concerné, et
// seulement si argv[0] vaut « url ». Toute erreur est absorbée : on rend au
// moins le nom de l'app.
const PROBE_SCRIPT = [
  "ObjC.import('AppKit');",
  `var SAFARIS = ${JSON.stringify(SAFARIS)};`,
  `var CHROMIUMS = ${JSON.stringify(CHROMIUMS)};`,
  "function run(argv) {",
  "  var out = { app: '', bundle: '', url: '', err: '' };",
  "  try {",
  "    var fa = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
  "    out.app = ObjC.unwrap(fa.localizedName) || '';",
  "    out.bundle = ObjC.unwrap(fa.bundleIdentifier) || '';",
  "  } catch (e) {",
  "    return JSON.stringify(out);",
  "  }",
  "  if (!out.app || argv[0] !== 'url') return JSON.stringify(out);",
  "  try {",
  "    if (SAFARIS.indexOf(out.app) !== -1) {",
  "      out.url = String(Application(out.app).windows[0].currentTab.url() || '');",
  "    } else if (CHROMIUMS.indexOf(out.app) !== -1) {",
  "      out.url = String(Application(out.app).windows[0].activeTab.url() || '');",
  "    }",
  "  } catch (e) {",
  "    out.url = '';",
  "    out.err = String(e);",
  "  }",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

/** Ce que la sonde rapporte. `err` distingue « pas de fenêtre ouverte » d'un
 *  refus d'Automatisation, pour pouvoir arrêter de redemander. */
export interface ProbeResult {
  app: string;
  bundle: string;
  url: string;
  err: string;
}

/** Sortie brute du script → résultat validé. Exporté pour les tests. */
export function parseProbe(raw: string): ProbeResult | null {
  try {
    const data = JSON.parse(raw.trim()) as Record<string, unknown>;
    if (typeof data["app"] !== "string" || !data["app"]) return null;
    const str = (key: string): string =>
      typeof data[key] === "string" ? (data[key] as string) : "";
    return {
      app: data["app"],
      bundle: str("bundle"),
      url: str("url"),
      err: str("err"),
    };
  } catch {
    return null;
  }
}

/**
 * Electron sérialise les objets ObjC qu'il ne sait pas convertir via
 * `-description`, ce qui donne ici
 * « <NSRunningApplication: 0x… (com.google.Chrome - 1234)> ». On n'en tire
 * qu'un identifiant de bundle, et seulement s'il en a la FORME : le format
 * n'est pas documenté, donc ce n'est JAMAIS une source de vérité — un échec
 * de lecture coûte simplement une sonde de plus. Exporté pour les tests.
 */
export function bundleIdFrom(info: Record<string, unknown>): string {
  const raw = info[APP_KEY];
  if (typeof raw !== "string") return "";
  return /\(([A-Za-z0-9][\w.-]*\.[\w.-]+) - \d+\)/.exec(raw)?.[1] ?? "";
}

const NONE: ActivitySnapshot = { context: "none", app: "", host: "" };

export interface ActivityWatcher {
  /** Dernière observation connue (jamais null). */
  current(): ActivitySnapshot;
  /** Suspend/reprend l'observation — appelé quand le compagnon se cache ou
   *  quand l'utilisateur décoche l'option. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export interface ActivityWatcherDeps {
  /** Nouvelle famille détectée (jamais rappelé pour une famille identique). */
  onChange(snapshot: ActivitySnapshot): void;
  // ---- injectables, uniquement pour des tests hors macOS ----------------
  /** Sonde one-shot ; par défaut, l'osascript NSWorkspace ci-dessus. */
  probe?(wantUrl: boolean): Promise<ProbeResult | null>;
  /** Abonnement aux changements d'app ; par défaut, NSWorkspace via Electron. */
  subscribeActivation?(cb: (bundleId: string) => void): () => void;
  /** Abonnement aux entrées réelles ; par défaut, celui de presence.ts. */
  subscribeInput?(cb: () => void): () => void;
}

/** Abonnement NSWorkspace par défaut. Hors macOS : rien à observer. */
function subscribeWorkspace(cb: (bundleId: string) => void): () => void {
  if (process.platform !== "darwin") return () => {};
  let id: number;
  try {
    id = systemPreferences.subscribeWorkspaceNotification(
      ACTIVATED,
      (_event, userInfo) => cb(bundleIdFrom(userInfo)),
    );
  } catch {
    // API absente ou refusée : on se passe des changements d'app, le reste
    // continue de fonctionner. Toujours aucun sondage.
    return () => {};
  }
  return () => {
    try {
      systemPreferences.unsubscribeWorkspaceNotification(id);
    } catch {
      // rien à faire à la fermeture
    }
  };
}

/** Sonde one-shot par défaut. Hors macOS : rien à observer. */
function osascriptProbe(wantUrl: boolean): Promise<ProbeResult | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = execFile(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", PROBE_SCRIPT, wantUrl ? "url" : "app"],
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
  const subscribeActivation = deps.subscribeActivation ?? subscribeWorkspace;
  const subscribeInput = deps.subscribeInput ?? onRealInput;

  let snapshot: ActivitySnapshot = NONE;
  let enabled = false;
  let disposed = false;
  /** Trop d'échecs d'affilée : on renonce jusqu'à la fin de la session. */
  let broken = false;

  let unsubActivation: (() => void) | null = null;
  let unsubInput: (() => void) | null = null;
  /** Deux minuteurs À UN COUP, jamais réarmés depuis eux-mêmes. */
  let debounceTimer: NodeJS.Timeout | null = null;
  let settleTimer: NodeJS.Timeout | null = null;

  /** Génération : une sonde qui revient après un stop est ignorée. */
  let gen = 0;
  /** Une sonde est en vol : ne jamais en empiler deux. */
  let probing = false;
  let lastUrlAt = 0;
  let hardFailures = 0;

  /** L'app au premier plan est-elle un navigateur ? Mis en cache pour que le
   *  chemin des entrées globales (~100 Hz) ne fasse qu'une lecture de champ. */
  let frontIsBrowser = false;

  /** bundle → nom localisé : revenir sur une app déjà vue ne coûte rien. */
  const nameByBundle = new Map<string, string>();
  /** Apps dont l'Automatisation a été refusée : on ne redemande plus. */
  const urlDenied = new Set<string>();

  const emit = (next: ActivitySnapshot) => {
    // Seul un changement de FAMILLE compte : passer d'un onglet YouTube à un
    // autre ne doit pas refaire clignoter le popcorn.
    const changed = next.context !== snapshot.context;
    snapshot = next;
    if (changed) deps.onChange(next);
  };

  /** Note ce qu'on vient d'apprendre et publie l'humeur correspondante. */
  const apply = (result: ProbeResult) => {
    hardFailures = 0;
    if (result.bundle) {
      if (nameByBundle.size >= NAME_CACHE_MAX) nameByBundle.clear();
      nameByBundle.set(result.bundle, result.app);
      if (result.err && isAutomationDenied(result.err)) {
        urlDenied.add(result.bundle);
      }
    }
    frontIsBrowser = isScriptableBrowser(result.app);
    emit(classifyActivity(result.app, result.url));
  };

  /** Publie depuis le cache, sans le moindre processus. */
  const applyCached = (app: string) => {
    frontIsBrowser = isScriptableBrowser(app);
    emit(classifyActivity(app, ""));
  };

  const runProbe = (wantUrl: boolean) => {
    if (disposed || !enabled || broken || probing) return;
    probing = true;
    const mine = gen;
    void probe(wantUrl)
      .then((result) => {
        if (mine !== gen || disposed || !enabled) return;
        if (result) {
          apply(result);
          return;
        }
        // Échec transitoire : on GARDE l'accessoire précédent plutôt que de le
        // faire clignoter. Répété, c'est un environnement cassé — on arrête.
        if (++hardFailures >= MAX_HARD_FAILURES) broken = true;
      })
      .catch(() => {
        // La décoration ne fait jamais tomber l'app hôte.
      })
      .finally(() => {
        probing = false;
      });
  };

  /** Une app vient de passer au premier plan. */
  const onActivation = (bundle: string) => {
    if (disposed || !enabled) return;
    const cached = bundle ? nameByBundle.get(bundle) : undefined;
    // Cache chaud et app non pilotable : zéro processus, réponse immédiate.
    if (cached !== undefined && !isScriptableBrowser(cached)) {
      applyCached(cached);
      return;
    }
    if (debounceTimer) return; // une seule attente en vol, jamais réarmée
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Sur un navigateur, la sonde ramène l'URL au passage — sauf si
      // l'Automatisation nous a déjà été refusée pour cette app.
      const wantUrl = bundle === "" || !urlDenied.has(bundle);
      lastUrlAt = Date.now();
      runProbe(wantUrl);
    }, ACTIVATION_DEBOUNCE_MS);
    debounceTimer.unref();
  };

  /** Entrée réelle de l'utilisateur — chemin chaud, garder ça minuscule. */
  const onInput = () => {
    if (!frontIsBrowser || !enabled || disposed || broken) return;
    if (settleTimer || probing) return;
    if (Date.now() - lastUrlAt < URL_MIN_GAP_MS) return;
    // La fenêtre est consommée à l'ARMEMENT, pas au déclenchement : une salve
    // de clics ne peut pas empiler des lectures.
    lastUrlAt = Date.now();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      runProbe(true);
    }, URL_SETTLE_MS);
    settleTimer.unref();
  };

  const stop = () => {
    gen++;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    unsubActivation?.();
    unsubActivation = null;
    unsubInput?.();
    unsubInput = null;
    probing = false;
    frontIsBrowser = false;
  };

  return {
    current: () => snapshot,
    setEnabled(next) {
      if (disposed || enabled === next) return;
      enabled = next;
      if (next) {
        unsubActivation = subscribeActivation(onActivation);
        // Naviguer demande un clic ou une frappe : c'est notre signal pour
        // relire l'onglet. Sans Accessibilité, uiohook ne démarre pas et ce
        // callback ne vient jamais — l'URL reste alors celle du moment où le
        // navigateur a pris le premier plan. Dégradé, mais sans sondage.
        unsubInput = subscribeInput(onInput);
        // L'app au premier plan a pu changer pendant la pause.
        lastUrlAt = Date.now();
        runProbe(true);
      } else {
        stop();
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
      stop();
    },
  };
}

/** Ré-export pratique pour les consommateurs main (index.ts). */
export type { ActivityContext, ActivitySnapshot };
