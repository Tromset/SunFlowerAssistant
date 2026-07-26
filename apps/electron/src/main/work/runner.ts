// Sunflower Work : la fleur pilote l'ordinateur pour une corvée non-code
// (« archive les newsletters »).
//
// ELLE S'Y MET TOUT DE SUITE. Il n'y a plus à quitter son bureau pour qu'un run
// démarre : `requiredIdleSec` vaut 0 par défaut, et la phase d'attente ne sert
// plus qu'à ceux qui la redemandent explicitement. Ce qui rend ça vivable, ce
// n'est pas d'attendre — c'est de CÉDER LE CURSEUR : dès que l'utilisateur
// touche sa machine, plus un seul geste ne part, la session passe en `paused`,
// et elle reprend d'elle-même après une accalmie (QUIET_MS). Personne ne se bat
// pour la souris, et un run n'est plus perdu parce qu'on a bougé la main.
// Qui préfère l'ancien réflexe met `onUserInput` sur « stop ».
//
// Boucle lente et bornée : on cède le curseur si besoin → capture d'écran (+
// la liste des éléments de la page, quand c'est un navigateur) → un tour de
// modèle vision qui rend EXACTEMENT une étape JSON → validation/clamp → on
// cède le curseur à nouveau (le tour de modèle a duré) → exécution via
// clicker.ts (CGEvents en points) → pause de stabilisation → recommencer. Tout
// est révocable à l'instant : le hotkey, une interruption de la machine à états
// ou la fermeture de l'app tuent l'osascript en vol et la requête.
//
// Rien ne sonde quoi que ce soit : l'attente comme la reprise sont assises sur
// presence.onRealInput (un événement), pas sur un réveil périodique.
//
// Deux choses le rendent tenable sur la durée, et c'est tout l'intérêt d'un
// modèle local :
//  - le TERMINAL SE RENOUVELLE. Chaque fenêtre de contexte est bornée ; quand
//    elle est pleine, le runner en ouvre une neuve avec un résumé de ce qui
//    précède. Un run peut donc durer bien plus longtemps que la fenêtre de
//    contexte d'un 8B.
//  - la CHATBOX. Ce que l'utilisateur écrit depuis l'app Work est servi au
//    modèle au tour suivant, comme une consigne en cours de route.
//
// CE QUI COMPTE UNE FENÊTRE PLEINE, ET POURQUOI ÇA A ÉTÉ REFAIT : chaque tour
// est une requête SANS ÉTAT — on renvoie le système, la tâche, l'historique et
// une capture entière. `prompt_eval_count` est donc la taille du prompt
// COURANT, pas ce que la fenêtre a gagné. L'accumuler (`windowTokens +=`)
// comptait une image complète par étape : le plafond de 5000 tombait au
// deuxième ou troisième geste, le terminal se renouvelait sans arrêt, et
// chaque renouvellement déchargeait le modèle — donc le tour suivant payait un
// rechargement à froid, souvent plus long que son propre délai d'attente. Un
// bug d'unité qui ressemblait à trois pannes : « elle ne fait que cliquer »,
// « elle s'arrête pendant des siècles », « elle ouvre des terminaux en
// boucle ». On mesure maintenant l'OCCUPATION (le prompt courant) contre la
// fenêtre réelle, et plus rien n'est déchargé en cours de route.
import type { StatePayload } from "../../shared/state";
import type {
  WorkSession,
  WorkSessionSummary,
  WorkSettings,
  WorkStatus,
} from "../../shared/work";
import { checkOllama, ollamaHost } from "../ollama";
import { getConfig } from "../config-store";
import { budgetFor, type SurfaceBudget } from "../../shared/effort";
import { captureScreenAtCursor, type Screenshot } from "../screenshot";
import { readFrontmostDom, type DomSnapshot } from "../dom-locator";
import { idleMs, onRealInput } from "../presence";
import { mouseHookAvailable } from "../hotkey";
import {
  ClickerError,
  KEY_NAMES,
  cancelClicker,
  clickAt,
  doubleClickAt,
  dragTo,
  isScrollDirection,
  openOnDesktop,
  parseHotkey,
  pressHotkey,
  pressKey,
  rightClickAt,
  scrollAt,
  typeText,
  type ScrollDirection,
} from "./clicker";
import {
  WORK_ACTIONS,
  actionHelpLines,
  describeStep,
  isWorkActionName,
  workStepSchema,
  type WorkStep,
} from "./actions";
import type { WorkStore } from "./store";

// ---- Garde-fous (lents PAR CONCEPTION) ----------------------------------
/** Phase d'attente seulement (`requiredIdleSec > 0`) : s'il reste au clavier
 *  au-delà, le run s'annule sans bruit. Sans attente demandée, hors jeu. */
const WAIT_MAX_MS = 120_000;
/** Accalmie exigée pour reprendre après que l'utilisateur a touché la machine.
 *  Assez court pour que le run ne traîne pas derrière une frappe finie, assez
 *  long pour ne pas se glisser entre deux mots. */
const QUIET_MS = 2000;
/** Attente d'un tour ; vient du preset d'effort (shared/effort.ts). */
const turnTimeoutMs = (): number => budget().firstTokenMs;
/** Premier tour d'un run : la machine peut avoir à CHARGER le modèle, ce qui
 *  n'a rien à voir avec le temps d'une réponse. Même raisonnement que
 *  FIRST_TOKEN_COLD_MS côté compagnon (ollama.ts). */
const COLD_START_MS = 180_000;
/** Pause de stabilisation entre deux gestes (l'UI doit retomber). */
const SETTLE_MIN_MS = 1500;
const SETTLE_JITTER_MS = 1000;
/** Réponses inexploitables tolérées d'affilée avant d'abandonner — hors
 *  format, ou pas rendues à temps. */
const MAX_BAD_REPLIES = 3;
/** Attentes de suite avant de secouer le modèle, puis d'abandonner. Sans ça,
 *  un modèle bloqué sur `wait` consomme les 300 étapes EN SILENCE : c'est ça,
 *  « elle s'arrête pendant des siècles ». */
const WAITS_BEFORE_NUDGE = 3;
const WAITS_BEFORE_STOP = 5;
/** Idem pour le geste identique rejoué à l'identique. */
const REPEATS_BEFORE_NUDGE = 3;
const REPEATS_BEFORE_STOP = 6;
// Même contexte que le tchat écran ; une étape JSON tient dans très peu de
// tokens (num_predict court = un tour raté coûte peu de temps). Les deux
// suivent le preset d'effort — « medium » redonne 8192 / 220.
const budget = (): SurfaceBudget => budgetFor(getConfig().effort, "work");
/** Occupation admise avant de renouveler la fenêtre : une fraction de la
 *  fenêtre RÉELLE, pas un nombre en dur. Ce qu'on y compare est la taille du
 *  prompt courant (voir l'en-tête), donc la marge restante sert au tour
 *  suivant, pas à rattraper une erreur de comptage. */
const terminalTokenBudget = (): number => Math.floor(budget().numCtx * 0.75);
/** …ou ce nombre d'étapes. Avec l'occupation enfin mesurée juste, c'est ce
 *  plafond-ci qui borne en pratique une fenêtre. */
const TERMINAL_BUDGET_STEPS = 60;
/** Étapes reprises dans le résumé de passation d'un terminal au suivant. */
const HANDOFF_STEPS = 8;
/** Éléments de page servis au modèle : au-delà c'est du bruit, et le prompt
 *  double de taille pour rien. */
const MAX_ELEMENT_HINTS = 40;

const SYSTEM_PROMPT = [
  "You are sunflower's computer-driving hand. You run fully locally. The user asked you to finish ONE task on their Mac, and you start right away — they may well be sitting there watching you.",
  "You share the machine with them: your gestures are held back automatically whenever they touch the keyboard or mouse, so the screen may have moved on between your turns. Always judge from the image, never from what you expected.",
  "The attached image is the CURRENT screen. Decide the SINGLE next input action that moves the task forward.",
  'Reply with EXACTLY one JSON object, nothing else: {"action":"…","x":0-1,"y":0-1,"x2":0-1,"y2":0-1,"text":"…","amount":1,"why":"short"}.',
  "x and y are fractions of the screen width and height (0-1) pointing at the CENTER of the target. x2 and y2 are the same, for the end of a drag.",
  "The actions you can take:",
  actionHelpLines(),
  "Keep why under 10 words. Be conservative: never touch system settings, never type passwords, never buy anything. One action per reply, no markdown, no prose outside the JSON.",
].join("\n");

/** Le tour de vérification d'un `done` : une seule question, sans historique. */
const VERIFY_PROMPT = [
  "You are checking someone else's work on a Mac. The attached image is the current screen.",
  "They claim the task below is finished. Look at the screen and say whether it really is.",
  'Reply with EXACTLY one JSON object: {"finished":true|false,"why":"short"}.',
  "Answer false if the screen shows the task still pending, or shows nothing that supports the claim. Answer true if the screen shows it done, or if the task was clearly impossible to begin with.",
].join("\n");

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    finished: { type: "boolean" },
    why: { type: "string" },
  },
  required: ["finished", "why"],
};

/** Supprime les blocs <think>…</think> (réponse non streamée, défensif). */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Isole l'unique objet JSON d'une réponse ; null si rien d'exploitable. */
function extractJson(raw: string): Record<string, unknown> | null {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Lit une fraction d'écran ; `false` = présente mais hors bornes.
 *
 *  Hors [0,1] (pourcentages, pixels…) : réponse invalide, on fait recommencer
 *  le modèle plutôt que de « clamper » vers un clic au bord de l'écran qui
 *  n'a rien à voir avec sa cible. */
function readFraction(value: unknown): number | false | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return false;
  return value;
}

/** Extrait et valide l'unique objet JSON de la réponse ; null sinon.
 *  Les champs exigés viennent du registre : une action ajoutée là est validée
 *  ici sans qu'on ait à y toucher. */
export function parseStep(raw: string): WorkStep | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const action = obj["action"];
  if (typeof action !== "string" || !isWorkActionName(action)) return null;
  const step: WorkStep = {
    action,
    why: typeof obj["why"] === "string" ? obj["why"].trim().slice(0, 100) : "",
  };
  for (const key of ["x", "y", "x2", "y2"] as const) {
    const value = readFraction(obj[key]);
    if (value === false) return null;
    if (value !== undefined) step[key] = value;
  }
  if (typeof obj["text"] === "string") step.text = obj["text"];
  const amount = obj["amount"];
  if (typeof amount === "number" && Number.isFinite(amount)) {
    step.amount = amount;
  }

  const needs = WORK_ACTIONS[action].needs;
  if (needs.includes("xy") && (step.x === undefined || step.y === undefined)) {
    return null;
  }
  if (needs.includes("xy2") && (step.x2 === undefined || step.y2 === undefined)) {
    return null;
  }
  if (needs.includes("text") && !step.text) return null;
  // Les trois arguments que le modèle écrit en toutes lettres sont validés
  // ICI, pas à l'exécution : une touche inventée ou un sens mal orthographié
  // est une faute de grammaire, donc un tour rejoué. Laisser le clicker la
  // refuser plus bas ferait mourir la course sur une broutille — et un sens de
  // défilement mal lu ferait défiler à l'envers.
  if (step.action === "scroll" && scrollDirection(step.text) === null) {
    return null;
  }
  if (
    step.action === "key" &&
    !KEY_NAMES.includes((step.text ?? "").trim().toLowerCase())
  ) {
    return null;
  }
  if (step.action === "hotkey" && !parseHotkey(step.text ?? "")) return null;
  return step;
}

/** « Down », « downwards », « scroll down » → "down" ; null si illisible. */
function scrollDirection(text: string | undefined): ScrollDirection | null {
  for (const word of (text ?? "").toLowerCase().split(/[^a-z]+/)) {
    if (isScrollDirection(word)) return word;
    if (word === "downwards" || word === "downward") return "down";
    if (word === "upwards" || word === "upward") return "up";
  }
  return null;
}

/** De quoi reconnaître un geste rejoué à l'identique (détection d'enlisement). */
function fingerprint(step: WorkStep): string {
  const n = (v: number | undefined) => (v === undefined ? "-" : v.toFixed(2));
  return [
    step.action,
    n(step.x),
    n(step.y),
    n(step.x2),
    n(step.y2),
    step.text ?? "",
  ].join("|");
}

// ---- Éléments de l'écran -------------------------------------------------
/** Un élément cliquable, en points globaux ET en fractions d'écran. */
interface ElementHint {
  label: string;
  px: number;
  py: number;
  fx: number;
  fy: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Convertit le relevé du DOM en cibles utilisables : centre de chaque boîte,
 * en points globaux (pour cliquer) et en fractions (pour le prompt). Ce qui
 * tombe hors de l'écran capturé est écarté — un autre display, une fenêtre à
 * moitié sortie.
 */
function elementHints(dom: DomSnapshot | null, b: Bounds): ElementHint[] {
  if (!dom) return [];
  const hints: ElementHint[] = [];
  const seen = new Set<string>();
  for (const el of dom.elements) {
    const label = el.label.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!label) continue;
    const px = el.x + el.w / 2;
    const py = el.y + el.h / 2;
    const fx = (px - b.x) / b.width;
    const fy = (py - b.y) / b.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ label, px, py, fx, fy });
    if (hints.length >= MAX_ELEMENT_HINTS) break;
  }
  return hints;
}

/** Retrouve l'élément visé par `click-label` : exact, puis début, puis
 *  contenu, dans les deux sens (le modèle raccourcit autant qu'il rallonge). */
function findLabelled(hints: ElementHint[], text: string): ElementHint | null {
  const want = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!want) return null;
  const flat = hints.map((h) => ({ h, label: h.label.toLowerCase() }));
  return (
    flat.find((c) => c.label === want)?.h ??
    flat.find((c) => c.label.startsWith(want))?.h ??
    flat.find((c) => c.label.includes(want))?.h ??
    flat.find((c) => want.includes(c.label))?.h ??
    null
  );
}

// ---- Un tour de modèle (vision, non streamé, borné) -----------------------
interface TurnResult {
  content: string;
  /** Taille du prompt qu'on vient d'envoyer : L'OCCUPATION de la fenêtre. */
  promptTokens: number;
  /** Prompt + génération : ce que ce tour a coûté (affiché, pas décisionnel). */
  tokens: number;
}

/** Le modèle n'a pas répondu à temps. Distinct d'une annulation de session :
 *  un tour lent fait recommencer le tour, il ne tue plus la course. */
class WorkTurnTimeout extends Error {}
/** Ollama a refusé le schéma passé en `format` (version trop ancienne). */
class WorkSchemaRejected extends Error {}

interface TurnOptions {
  model: string;
  system: string;
  user: string;
  shot: Screenshot;
  format: unknown;
  timeoutMs: number;
  signal: AbortSignal;
}

async function modelTurn(opts: TurnOptions): Promise<TurnResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        think: false,
        format: opts.format,
        keep_alive: "10m",
        options: {
          temperature: 0.1,
          num_ctx: budget().numCtx,
          num_predict: budget().numPredict,
        },
        messages: [
          { role: "system", content: opts.system },
          {
            role: "user",
            content: opts.user,
            images: [opts.shot.imageB64],
          },
        ],
      }),
    });
    if (!res.ok) {
      // 400 sur un `format` structuré : Ollama trop ancien pour les schémas.
      // On le dit une fois et on repasse en JSON libre pour le reste du run.
      if (res.status === 400 && typeof opts.format !== "string") {
        throw new WorkSchemaRejected("schema rejected");
      }
      throw new Error(`ollama responded ${res.status}.`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      error?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    if (data.error) throw new Error(`ollama: ${data.error}`);
    const promptTokens = data.prompt_eval_count ?? 0;
    return {
      content: data.message?.content ?? "",
      promptTokens,
      tokens: promptTokens + (data.eval_count ?? 0),
    };
  } catch (err) {
    if (timedOut && !opts.signal.aborted) {
      throw new WorkTurnTimeout("the model didn't answer in time.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Deuxième regard sur un `done`, sur une capture FRAÎCHE et sans historique :
 * on ne demande pas au modèle de se relire, on lui demande de REGARDER.
 *
 * Ne lève jamais : tout ce qui rate ici (capture, réseau, format) rend null,
 * et null vaut « on te croit ». Un garde-fou contre l'arrêt prématuré ne doit
 * pas devenir une raison de ne jamais s'arrêter.
 */
async function verifyDone(
  task: string,
  claim: string,
  model: string,
  useSchema: boolean,
  signal: AbortSignal,
): Promise<{ finished: boolean; why: string } | null> {
  try {
    const shot = await captureScreenAtCursor();
    if (!shot || !shot.displayMatched) return null;
    const turn = await modelTurn({
      model,
      system: VERIFY_PROMPT,
      user: [
        `Task they were asked to finish: ${task}`,
        `What they said: ${claim || "(nothing)"}`,
        "",
        "The image is the screen right now. Is the task really finished?",
      ].join("\n"),
      shot,
      format: useSchema ? VERIFY_SCHEMA : "json",
      timeoutMs: turnTimeoutMs(),
      signal,
    });
    const obj = extractJson(turn.content);
    if (!obj || typeof obj["finished"] !== "boolean") return null;
    return {
      finished: obj["finished"],
      why: typeof obj["why"] === "string" ? obj["why"].trim().slice(0, 100) : "",
    };
  } catch {
    return null;
  }
}

// ---- Runner ---------------------------------------------------------------
export interface WorkFinish {
  status: "done" | "aborted" | "failed";
  task: string;
  message: string;
  steps: number;
}

export interface WorkRunnerDeps {
  /** Réglages courants (opt-in, seuils) — relus à chaque départ de session. */
  settings(): WorkSettings;
  /** Persiste les réglages modifiés depuis l'app Work. */
  saveSettings(patch: Partial<WorkSettings>): WorkSettings;
  /** État ambiant (île « acting » + vignette « working » du compagnon). */
  broadcast(payload: StatePayload): void;
  /** Fin de run : message final sur l'île + Notification (voir index.ts). */
  onFinished(result: WorkFinish): void;
  /** La liste des sessions a changé (app Work + panneau). */
  onSessionsChanged(sessions: WorkSessionSummary[]): void;
  /** Ligne de journal terminal (facultatif). */
  onLog?(line: string): void;
}

export interface WorkRunner {
  /** Enfile une tâche ; null si refusée (opt-in absent, plateforme, vide). */
  start(task: string): WorkSessionSummary | null;
  list(): WorkSessionSummary[];
  get(id: string): WorkSession | null;
  /** Message de la chatbox : consigne servie au modèle au prochain tour. */
  chat(id: string, text: string): void;
  /** Un run pilote-t-il actuellement la machine ? */
  active(): boolean;
  /** Abandon immédiat du run en cours : tue l'osascript, coupe la requête. */
  cancel(reason?: string): void;
  /** Annule UNE session (en file ou en cours). */
  cancelSession(id: string, reason?: string): void;
  settings(): WorkSettings;
  setSettings(patch: Partial<WorkSettings>): WorkSettings;
  dispose(): void;
}

export function createWorkRunner(
  store: WorkStore,
  deps: WorkRunnerDeps,
): WorkRunner {
  let gen = 0;
  /** Session en cours de pilotage ; null quand la file est au repos. */
  let activeId: string | null = null;
  let ctrl: AbortController | null = null;
  let cancelReason: string | null = null;
  let unsubInput: (() => void) | null = null;
  let disposed = false;

  const announce = () => deps.onSessionsChanged(store.list());
  const log = (id: string, level: "info" | "step" | "warn" | "error", text: string) => {
    store.log(id, level, text);
    deps.onLog?.(`work: ${text}`);
  };

  /** Pause révocable : se termine tôt si le run est annulé. */
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

  /**
   * Attend `quietMs` SANS la moindre entrée réelle de l'utilisateur, et rend la
   * main au plus tard au bout de `maxMs` (0 = pas de plafond).
   *
   * Événementiel, pas sondeur : un seul timer d'accalmie est armé, et chaque
   * entrée réelle (presence.onRealInput) l'annule et le ré-arme. Quand personne
   * ne touche rien, ça ne se réveille pas une seule fois — là où la boucle
   * `while (idleMs() < …) await sleep(1000)` d'avant se réveillait chaque
   * seconde pendant toute l'attente. Voir le budget always-on de CLAUDE.md.
   *
   * Le plafond est INTERNE et non un Promise.race : sur une course, la promesse
   * perdante resterait abonnée à onRealInput pour la vie du process — un coût
   * permanent invisible, exactement ce que ce dépôt refuse. Ici, quelle que
   * soit la raison de sortie, `done()` désabonne et désarme.
   *
   * Rend VRAI si l'accalmie a bien été obtenue, FAUX si on sort par le plafond
   * ou par une annulation. C'est la promesse qui dit pourquoi elle s'arrête :
   * relire `idleMs()` après coup se jouerait à la milliseconde près, un
   * setTimeout pouvant rendre la main juste avant son échéance.
   */
  const waitForQuiet = (
    quietMs: number,
    signal: AbortSignal,
    maxMs = 0,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      let cap: ReturnType<typeof setTimeout> | null = null;
      const done = (quiet: boolean) => {
        if (timer) clearTimeout(timer);
        if (cap) clearTimeout(cap);
        timer = null;
        cap = null;
        unsubQuiet();
        signal.removeEventListener("abort", onAbort);
        resolve(quiet);
      };
      // Ré-armement sur entrée réelle : le compte à rebours repart de zéro.
      const unsubQuiet = onRealInput(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => done(true), quietMs);
      });
      const onAbort = () => done(false);
      signal.addEventListener("abort", onAbort, { once: true });
      // Déjà calme depuis assez longtemps ? On part du reste à courir.
      const remaining = quietMs - idleMs();
      if (remaining <= 0) {
        done(true);
        return;
      }
      if (maxMs > 0) cap = setTimeout(() => done(false), maxMs);
      timer = setTimeout(() => done(true), remaining);
    });

  const abort = (reason: string) => {
    if (!activeId || cancelReason !== null) return;
    cancelReason = reason;
    ctrl?.abort();
    cancelClicker();
  };

  const finish = (id: number, sessionId: string, result: WorkFinish) => {
    if (id !== gen || activeId !== sessionId) return;
    activeId = null;
    unsubInput?.();
    unsubInput = null;
    ctrl = null;
    cancelClicker();
    const status: WorkStatus =
      result.status === "done"
        ? "done"
        : result.status === "aborted"
          ? "aborted"
          : "failed";
    store.setStatus(sessionId, status, result.message);
    log(sessionId, status === "failed" ? "error" : "info", `${status} — ${result.message}`);
    announce();
    deps.onFinished(result);
    // La file continue : une autre session peut attendre son tour.
    setTimeout(pump, 0);
  };

  const run = async (id: number, sessionId: string): Promise<void> => {
    const signal = ctrl!.signal;
    const session = store.get(sessionId);
    if (!session) return;
    const task = session.task;
    const settings = deps.settings();
    const requiredIdleMs = settings.requiredIdleSec * 1000;
    const totalMs = settings.budgetMin > 0 ? settings.budgetMin * 60_000 : 0;
    const maxSteps = settings.maxSteps;
    const t0 = Date.now();
    const overTime = () => totalMs > 0 && Date.now() - t0 >= totalMs;
    /** Ce qu'il reste à courir, 0 = illimité (c'est le réglage, pas un défaut). */
    const remainingMs = () => (totalMs > 0 ? Math.max(1, totalMs - (Date.now() - t0)) : 0);
    const aborted = () => id !== gen || signal.aborted;
    /** L'utilisateur a-t-il touché sa machine depuis la dernière étape ? Sert à
     *  jeter une décision prise sur une capture devenue périmée. */
    let userActive = false;
    let steps = 0;
    /** Étapes jetées parce que l'écran avait bougé sous le modèle — comptées
     *  pour que le message de fin dise la vérité si le budget y passe. */
    let dropped = 0;

    /** Nom du modèle, résolu UNE fois : `checkOllama()` à chaque étape, c'est
     *  un aller-retour HTTP par geste. Remis à null au moindre échec, pour que
     *  la tentative suivante resonde. */
    let modelName: string | null = null;
    const resolveModel = async (): Promise<string> => {
      if (modelName) return modelName;
      const status = await checkOllama();
      if (!status.reachable) {
        throw new Error("ollama can't be reached — run ollama serve.");
      }
      if (!status.pulled) {
        throw new Error(`model missing — ollama pull ${status.name}`);
      }
      modelName = status.name;
      return modelName;
    };

    /** Rend le curseur à l'utilisateur, puis reprend là où on en était.
     *  No-op en mode « stop » (là, une entrée réelle a déjà tout annulé) et
     *  quand la machine est déjà calme — c'est `idleMs()` qui tranche, pas le
     *  drapeau : inutile d'afficher une pause pour une frappe finie depuis
     *  longtemps (typiquement pendant un long tour de modèle). */
    const yieldToUser = async (): Promise<void> => {
      if (settings.onUserInput === "stop" || aborted()) return;
      if (idleMs() >= QUIET_MS) {
        userActive = false;
        return;
      }
      store.setStatus(sessionId, "paused");
      announce();
      deps.broadcast({
        island: "acting",
        pose: "working",
        message: "paused — the mac is yours",
      });
      // Plafonné au budget RESTANT du run. Sans ce plafond, une session mise
      // en pause devant quelqu'un qui travaille ne rendait jamais la main :
      // elle n'expirait pas, n'échouait pas, et bloquait la file — le budget
      // n'étant relu qu'APRÈS la pause. Le plafond atteint, la boucle repasse
      // par overTime() et conclut honnêtement.
      await waitForQuiet(QUIET_MS, signal, remainingMs());
      userActive = false;
      if (aborted() || overTime()) return;
      store.setStatus(sessionId, "running");
      announce();
      deps.broadcast({
        island: "acting",
        pose: "working",
        message: "picking it back up…",
      });
    };

    try {
      // -- Phase d'attente : ne sert QUE si elle a été demandée (0 par défaut).
      //    Le cas normal démarre sur-le-champ ; c'est yieldToUser(), plus bas,
      //    qui empêche de se battre pour le curseur.
      if (requiredIdleMs > 0) {
        store.setStatus(sessionId, "waiting-idle");
        announce();
        deps.broadcast({
          island: "acting",
          pose: "working",
          message: "waiting for you to step away…",
        });
        log(
          sessionId,
          "info",
          `task accepted — "${task}" (waiting for ${settings.requiredIdleSec}s of idle)`,
        );
        // Assez calme, ou la patience est épuisée : deux timers armés une fois,
        // pas un réveil par seconde.
        const wentQuiet = await waitForQuiet(
          requiredIdleMs,
          signal,
          WAIT_MAX_MS,
        );
        if (aborted()) {
          finish(id, sessionId, {
            status: "aborted",
            task,
            message: cancelReason ?? "cancelled.",
            steps,
          });
          return;
        }
        if (!wentQuiet) {
          finish(id, sessionId, {
            status: "aborted",
            task,
            message: "you stayed at the keyboard — nothing was touched.",
            steps,
          });
          return;
        }
      } else {
        log(sessionId, "info", `task accepted — "${task}" (starting now)`);
      }
      // -- Une entrée réelle : on rend le curseur, ou on abandonne. Le choix
      //    est à l'utilisateur (`onUserInput`), le défaut est de rendre.
      unsubInput = onRealInput(() => {
        if (settings.onUserInput === "stop") {
          abort("you came back — hands off, all yours.");
          return;
        }
        userActive = true;
      });
      store.setStatus(sessionId, "running");
      store.openTerminal(sessionId);
      announce();

      /** Trace de la fenêtre de contexte courante. */
      let history: string[] = [];
      /** Résumé hérité du terminal précédent. */
      let handoff = "";
      /** Taille du dernier prompt envoyé = occupation de la fenêtre. */
      let windowTokens = 0;
      let windowSteps = 0;
      let badReplies = 0;
      /** Le prochain tour peut avoir à charger le modèle (premier de la course). */
      let mayBeCold = true;
      /** Schémas structurés acceptés par cet Ollama ? Basculé une seule fois. */
      let useSchema = true;
      /** Remarque à glisser au modèle au prochain tour (enlisement, `done`
       *  démenti par l'écran). Consommée une fois. */
      let nudge: string | null = null;
      /** Enlisement : attentes de suite, et geste rejoué à l'identique. */
      let waits = 0;
      let repeats = 0;
      let lastPrint = "";
      /** Un seul `done` est vérifié par course — sinon un run pourrait ne
       *  jamais pouvoir se terminer. */
      let doneChecked = false;

      /** Ferme la fenêtre courante et en ouvre une neuve.
       *
       *  On ne décharge plus le modèle au passage. `/api/chat` est sans état
       *  d'une requête à l'autre : changer les messages SUFFIT à jeter ce qui
       *  précède. Le `keep_alive: 0` d'avant n'apportait rien et coûtait un
       *  rechargement à froid en plein milieu d'une corvée. */
      const renewTerminal = () => {
        const tail = history.slice(-HANDOFF_STEPS);
        handoff = [
          handoff ? `(earlier) ${handoff}` : "",
          `Steps ${Math.max(1, steps - tail.length + 1)}-${steps}:`,
          ...tail,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(-2000);
        store.openTerminal(sessionId, handoff);
        log(
          sessionId,
          "info",
          `context full (${windowTokens} tokens, ${windowSteps} steps) — opening a fresh terminal`,
        );
        history = [];
        windowTokens = 0;
        windowSteps = 0;
        announce();
      };

      for (let i = 1; i <= maxSteps; i++) {
        if (aborted()) break;
        // Ne pas photographier un écran que l'utilisateur est en train de
        // changer : la décision du modèle porterait sur une image périmée.
        await yieldToUser();
        if (aborted()) break;
        if (overTime()) {
          finish(id, sessionId, {
            status: "failed",
            task,
            message: `time budget spent (${settings.budgetMin} min) — stopped where it was.`,
            steps,
          });
          return;
        }
        if (
          windowTokens >= terminalTokenBudget() ||
          windowSteps >= TERMINAL_BUDGET_STEPS
        ) {
          renewTerminal();
          if (aborted()) break;
        }
        deps.broadcast({
          island: "acting",
          pose: "working",
          message: `looking at the screen (step ${i})…`,
        });
        const shot = await captureScreenAtCursor();
        if (aborted()) break;
        if (!shot) {
          finish(id, sessionId, {
            status: "failed",
            task,
            message: "screen capture failed — check the permission.",
            steps,
          });
          return;
        }
        if (!shot.displayMatched) {
          // L'image peut montrer un autre écran que celui où on cliquerait :
          // piloter à l'aveugle est exclu, on s'arrête net.
          finish(id, sessionId, {
            status: "failed",
            task,
            message:
              "couldn't match the screenshot to your current screen (multi-display) — refusing to click blind.",
            steps,
          });
          return;
        }
        const b = shot.display.bounds;
        // Le relevé du DOM ne répond que pour un navigateur au premier plan,
        // et jamais par une exception : ailleurs, on retombe sur la seule
        // image. C'est ce qui permet à `click-label` de viser une case au lieu
        // de deviner des coordonnées sur un JPEG.
        const hints = elementHints(await readFrontmostDom(), b);
        if (aborted()) break;
        const guidance = store.drainGuidance(sessionId);
        if (guidance.length > 0) {
          log(sessionId, "info", `new instruction: ${guidance.join(" / ")}`);
        }

        const userMessage = [
          `Task: ${task}`,
          "",
          ...(handoff
            ? ["Earlier in this run (previous context window):", handoff, ""]
            : []),
          "Actions already performed:",
          history.length > 0 ? history.join("\n") : "(none yet)",
          "",
          ...(hints.length > 0
            ? [
                "Elements on screen right now, with the exact centre of each — use click-label with one of these labels rather than guessing coordinates:",
                hints
                  .map(
                    (h) =>
                      `- "${h.label}" (${h.fx.toFixed(2)}, ${h.fy.toFixed(2)})`,
                  )
                  .join("\n"),
                "",
              ]
            : []),
          ...(guidance.length > 0
            ? [
                "The user just told you, mid-run — follow this over your own plan:",
                guidance.map((g) => `- ${g}`).join("\n"),
                "",
              ]
            : []),
          ...(nudge ? [nudge, ""] : []),
          "The image is the CURRENT screen. Reply with the single next JSON action.",
        ].join("\n");
        nudge = null;

        let turn: TurnResult;
        try {
          turn = await modelTurn({
            model: await resolveModel(),
            system: SYSTEM_PROMPT,
            user: userMessage,
            shot,
            format: useSchema ? workStepSchema() : "json",
            timeoutMs: mayBeCold ? COLD_START_MS : turnTimeoutMs(),
            signal,
          });
          mayBeCold = false;
        } catch (err) {
          if (aborted()) break;
          if (err instanceof WorkSchemaRejected) {
            // Pas une mauvaise réponse : on n'en tient pas compte, on rejoue
            // le tour en JSON libre.
            useSchema = false;
            log(
              sessionId,
              "info",
              "this ollama doesn't take response schemas — falling back to plain JSON",
            );
            i--;
            continue;
          }
          if (err instanceof WorkTurnTimeout) {
            // Un tour lent ne tue plus la course : il la fait rejouer. C'est
            // pendant un chargement de modèle que ça arrivait le plus, et une
            // corvée de deux heures mourait sur « This operation was aborted ».
            modelName = null;
            mayBeCold = true;
            badReplies++;
            history.push(`${i}. (the model didn't answer in time — retry)`);
            log(sessionId, "warn", "the model ran out of time this turn — retrying");
            if (badReplies > MAX_BAD_REPLIES) {
              finish(id, sessionId, {
                status: "failed",
                task,
                message:
                  "the model kept running out of time — it may be too big for this machine.",
                steps,
              });
              return;
            }
            continue;
          }
          throw err;
        }
        if (aborted()) break;
        // OCCUPATION, pas cumul : c'est la taille du prompt qu'on vient
        // d'envoyer. Voir l'en-tête du fichier.
        windowTokens = turn.promptTokens;
        store.addTokens(sessionId, turn.tokens);
        const step = parseStep(turn.content);
        if (!step) {
          badReplies++;
          history.push(`${i}. (reply was not a valid JSON action — retry)`);
          log(sessionId, "warn", "the model answered off-format — retrying");
          if (badReplies > MAX_BAD_REPLIES) {
            finish(id, sessionId, {
              status: "failed",
              task,
              message: "the model kept answering off-format.",
              steps,
            });
            return;
          }
          continue;
        }
        badReplies = 0;

        if (step.action === "done") {
          // Le modèle sort volontiers trop tôt : le prompt l'invite à conclure
          // « dès que c'est fini OU manifestement impossible », et un petit
          // modèle vision prend vite le second cas. On regarde donc une fois,
          // sur une image FRAÎCHE, avant de le croire. Une seule fois : au
          // second `done`, on le laisse partir quoi qu'il arrive.
          if (!doneChecked) {
            doneChecked = true;
            const verdict = await verifyDone(
              task,
              step.why,
              await resolveModel(),
              useSchema,
              signal,
            );
            if (aborted()) break;
            if (verdict && !verdict.finished) {
              log(
                sessionId,
                "warn",
                `it called the task finished — a second look says otherwise: ${verdict.why}`,
              );
              history.push(
                `${i}. said the task was done — checked the screen, and it wasn't: ${verdict.why}`,
              );
              nudge = `You just said the task was finished. A second look at the screen says otherwise: ${verdict.why}. Keep going.`;
              continue;
            }
          }
          store.chat(sessionId, "sunflower", step.why || "task finished.");
          finish(id, sessionId, {
            status: "done",
            task,
            message: step.why || "task finished.",
            steps,
          });
          return;
        }
        // L'utilisateur a touché sa machine PENDANT le tour de modèle : la
        // capture qui a servi à décider ne vaut plus rien. On rend le curseur
        // et on rejuge sur une image neuve, plutôt que de cliquer à l'aveugle
        // aux coordonnées d'un écran qui a bougé.
        if (userActive) {
          dropped++;
          log(
            sessionId,
            "info",
            "you took the mac back mid-thought — dropping this step and looking again",
          );
          await yieldToUser();
          if (aborted()) break;
          continue;
        }
        // -- Enlisement. Un modèle qui répète le même geste, ou qui attend
        //    indéfiniment, ne « travaille » pas : il faut le secouer, puis
        //    s'arrêter en le DISANT plutôt que d'user 300 étapes en silence.
        //
        //    Compté ICI, après le rejet des étapes périmées : une étape jetée
        //    parce que l'utilisateur avait la main n'a jamais eu lieu, et
        //    qu'il reprenne la souris six fois pendant que le modèle propose
        //    la même chose ne veut pas dire que le modèle est bloqué.
        const print = fingerprint(step);
        repeats = print === lastPrint ? repeats + 1 : 0;
        lastPrint = print;
        waits = step.action === "wait" ? waits + 1 : 0;
        if (waits >= WAITS_BEFORE_STOP) {
          finish(id, sessionId, {
            status: "failed",
            task,
            message: `waited ${waits} times in a row with nothing changing on screen — stopped instead of hanging.`,
            steps,
          });
          return;
        }
        if (repeats >= REPEATS_BEFORE_STOP) {
          finish(id, sessionId, {
            status: "failed",
            task,
            message: `stuck repeating the same ${step.action} — it changed nothing, so it stopped rather than keep going.`,
            steps,
          });
          return;
        }
        if (waits >= WAITS_BEFORE_NUDGE) {
          nudge = `You have waited ${waits} turns in a row and the screen is not moving. Do something else, or call it done and say why.`;
        } else if (repeats >= REPEATS_BEFORE_NUDGE) {
          nudge = `You have asked for the exact same ${step.action} ${repeats + 1} times and nothing changed. It is not working — try a different target or a different approach.`;
        }
        // Étape annoncée : île + vignette « working » (casque + clé).
        deps.broadcast({
          island: "acting",
          pose: "working",
          message: step.why || describeStep(step),
        });
        log(sessionId, "step", `step ${i}: ${describeStep(step)}`);
        const record = store.pushCall(sessionId, {
          step: i,
          action: step.action,
          ...(step.x !== undefined ? { x: step.x } : {}),
          ...(step.y !== undefined ? { y: step.y } : {}),
          ...(step.x2 !== undefined ? { x2: step.x2 } : {}),
          ...(step.y2 !== undefined ? { y2: step.y2 } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.amount !== undefined ? { amount: step.amount } : {}),
          why: step.why,
          status: "running",
        });
        // CGEvents en POINTS : bornes du display Electron (points), jamais
        // la taille pixel de la capture (scaleFactor déjà hors jeu ici).
        const px = b.x + (step.x ?? 0) * b.width;
        const py = b.y + (step.y ?? 0) * b.height;
        const px2 = b.x + (step.x2 ?? 0) * b.width;
        const py2 = b.y + (step.y2 ?? 0) * b.height;
        /** Un geste peut rater SANS tuer la course : cible refusée par le
         *  garde-fou, libellé absent de l'écran. On l'inscrit, on le redit au
         *  modèle, et le tour suivant essaie autre chose. */
        let softError: string | null = null;
        try {
          switch (step.action) {
            case "wait":
              await sleep(SETTLE_MIN_MS + SETTLE_JITTER_MS, signal);
              break;
            case "click":
              await clickAt(px, py);
              break;
            case "double-click":
              await doubleClickAt(px, py);
              break;
            case "right-click":
              await rightClickAt(px, py);
              break;
            case "type":
              await clickAt(px, py);
              await sleep(300, signal);
              // La frappe s'interrompt entre deux tranches si l'utilisateur
              // reprend la main — on ne tape pas par-dessus lui.
              if (!aborted()) await typeText(step.text ?? "", () => userActive);
              break;
            case "key":
              await pressKey(step.text ?? "");
              break;
            case "hotkey":
              await pressHotkey(step.text ?? "");
              break;
            case "scroll": {
              const direction = scrollDirection(step.text);
              // parseStep l'a déjà exigé ; ceci garde le type honnête.
              if (direction) await scrollAt(px, py, direction, step.amount);
              break;
            }
            case "drag":
              await dragTo(px, py, px2, py2);
              break;
            case "open":
              try {
                const label = await openOnDesktop(step.text ?? "");
                log(sessionId, "info", `opened ${label}`);
              } catch (err) {
                softError =
                  err instanceof ClickerError
                    ? err.userMessage
                    : "couldn't open that.";
              }
              break;
            case "click-label": {
              const hit = findLabelled(hints, step.text ?? "");
              if (!hit) {
                softError = `nothing on screen is labelled "${(step.text ?? "").slice(0, 40)}" — click by coordinates instead.`;
              } else {
                await clickAt(hit.px, hit.py);
              }
              break;
            }
            // `done` est traité plus haut et sort de la boucle : tsc l'a déjà
            // retiré du type ici, d'où son absence de cas.
            default: {
              // tsc refuse de compiler si une action du registre n'a pas son
              // cas — c'est exactement ce que l'ancien `else` fourre-tout
              // laissait passer, en la transformant en appui de touche.
              const never: never = step.action;
              throw new Error(`unhandled work action ${String(never)}`);
            }
          }
        } catch (err) {
          if (record) {
            store.updateCall(sessionId, record.id, {
              status: "error",
              note:
                err instanceof ClickerError
                  ? err.userMessage
                  : err instanceof Error
                    ? err.message
                    : "the gesture failed.",
            });
          }
          throw err;
        }
        if (softError) {
          if (record) {
            store.updateCall(sessionId, record.id, {
              status: "error",
              note: softError,
            });
          }
          log(sessionId, "warn", softError);
          history.push(`${i}. ${describeStep(step)} — did not happen: ${softError}`);
          windowSteps++;
          announce();
          await sleep(SETTLE_MIN_MS, signal);
          continue;
        }
        if (record) store.updateCall(sessionId, record.id, { status: "done" });
        steps++;
        windowSteps++;
        history.push(`${i}. ${describeStep(step)}`);
        announce();
        // Stabilisation : l'écran doit refléter le geste avant de rejuger.
        await sleep(
          SETTLE_MIN_MS + Math.floor(Math.random() * SETTLE_JITTER_MS),
          signal,
        );
      }
      if (aborted()) {
        finish(id, sessionId, {
          status: "aborted",
          task,
          message: cancelReason ?? "cancelled.",
          steps,
        });
        return;
      }
      finish(id, sessionId, {
        status: "failed",
        task,
        message:
          dropped > 0
            ? `step budget spent (${maxSteps}) without finishing — ${dropped} of them dropped because you were using the mac.`
            : `step budget spent (${maxSteps}) without finishing.`,
        steps,
      });
    } catch (err) {
      if (aborted()) {
        finish(id, sessionId, {
          status: "aborted",
          task,
          message: cancelReason ?? "cancelled.",
          steps,
        });
        return;
      }
      finish(id, sessionId, {
        status: "failed",
        task,
        message:
          err instanceof ClickerError
            ? err.userMessage
            : err instanceof Error
              ? err.message
              : "something went wrong.",
        steps,
      });
    }
  };

  /** Démarre la session suivante si la file est libre. */
  function pump(): void {
    if (disposed || activeId) return;
    const next = store.queued()[0];
    if (!next) return;
    if (!deps.settings().enabled) return; // opt-in retiré entre-temps
    activeId = next.id;
    cancelReason = null;
    ctrl = new AbortController();
    gen++;
    void run(gen, next.id);
  }

  return {
    start(task) {
      const t = task.trim();
      if (!t || disposed || !deps.settings().enabled) return null;
      if (process.platform !== "darwin") {
        deps.onLog?.("work: refused — macOS only.");
        return null;
      }
      const session = store.create(t);
      if (!mouseHookAvailable()) {
        // Sans hook global, impossible de savoir si l'utilisateur revient :
        // on refuse plutôt que de piloter à l'aveugle (sécurité d'abord).
        const message =
          "presence guard unavailable — grant Accessibility to sunflower first.";
        store.setStatus(session.id, "failed", message);
        log(session.id, "error", message);
        announce();
        deps.onFinished({ status: "failed", task: t, message, steps: 0 });
        return store.summary(session);
      }
      announce();
      pump();
      return store.summary(session);
    },
    list: () => store.list(),
    get: (id) => store.get(id),
    chat(id, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      store.chat(id, "user", trimmed.slice(0, 500));
    },
    active: () => activeId !== null,
    cancel(reason) {
      abort(reason ?? "cancelled.");
    },
    cancelSession(id, reason) {
      const session = store.get(id);
      if (!session) return;
      if (id === activeId) {
        abort(reason ?? "cancelled.");
        return;
      }
      if (session.status === "queued") {
        store.setStatus(id, "aborted", reason ?? "cancelled before it started.");
        announce();
      }
    },
    settings: () => deps.settings(),
    setSettings(patch) {
      const next = deps.saveSettings(patch);
      // Couper l'interrupteur arrête aussi tout run en cours, sur-le-champ.
      if (!next.enabled) abort("switched off.");
      else pump();
      return next;
    },
    dispose() {
      disposed = true;
      gen++;
      activeId = null;
      unsubInput?.();
      unsubInput = null;
      ctrl?.abort();
      ctrl = null;
      cancelClicker();
    },
  };
}
