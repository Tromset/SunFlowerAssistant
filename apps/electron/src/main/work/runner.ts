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
// Boucle lente et bornée : on cède le curseur si besoin → capture d'écran → un
// tour de modèle vision qui rend EXACTEMENT une étape JSON → validation/clamp →
// on cède le curseur à nouveau (le tour de modèle a duré) → exécution via
// clicker.ts (CGEvents en points) → pause de stabilisation → recommencer. Tout
// est révocable à l'instant : le hotkey, une interruption de la machine à états
// ou la fermeture de l'app tuent l'osascript en vol et la requête.
//
// Rien ne sonde quoi que ce soit : l'attente comme la reprise sont assises sur
// presence.onRealInput (un événement), pas sur un réveil périodique.
//
// Deux choses le rendent tenable sur la durée, et c'est tout l'intérêt d'un
// modèle local :
//  - le TERMINAL SE RENOUVELLE. Chaque fenêtre de contexte est bornée en
//    tokens ; quand elle est pleine, le runner en ouvre une neuve avec un
//    résumé de ce qui précède et décharge le runner Ollama pour jeter son
//    état. Un run peut donc durer bien plus longtemps que la fenêtre de
//    contexte d'un 8B.
//  - la CHATBOX. Ce que l'utilisateur écrit depuis l'app Work est servi au
//    modèle au tour suivant, comme une consigne en cours de route.
//
// Toute l'activité (journal, gestes, terminaux, chat) vit dans le store
// (work/store.ts) que l'app Work rend en direct.
import type { StatePayload } from "../../shared/state";
import type {
  WorkActionName,
  WorkSession,
  WorkSessionSummary,
  WorkSettings,
  WorkStatus,
} from "../../shared/work";
import { checkOllama, ollamaHost } from "../ollama";
import { getConfig } from "../config-store";
import { budgetFor, type SurfaceBudget } from "../../shared/effort";
import { captureScreenAtCursor, type Screenshot } from "../screenshot";
import { idleMs, onRealInput } from "../presence";
import { mouseHookAvailable } from "../hotkey";
import {
  ClickerError,
  KEY_NAMES,
  cancelClicker,
  clickAt,
  doubleClickAt,
  pressKey,
  typeText,
} from "./clicker";
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
/** Pause de stabilisation entre deux gestes (l'UI doit retomber). */
const SETTLE_MIN_MS = 1500;
const SETTLE_JITTER_MS = 1000;
/** Réponses hors format tolérées d'affilée avant d'abandonner. */
const MAX_BAD_REPLIES = 3;
// Même contexte que le tchat écran ; une étape JSON tient dans très peu de
// tokens (num_predict court = un tour raté coûte peu de temps). Les deux
// suivent le preset d'effort — « medium » redonne 8192 / 220.
const budget = (): SurfaceBudget => budgetFor(getConfig().effort, "work");
/** Tokens consommés dans une fenêtre avant de la renouveler. Volontairement
 *  bien sous la fenêtre : ce qui dégrade un petit modèle vision, c'est l'état
 *  accumulé du runner, pas seulement le dépassement de fenêtre. */
const TERMINAL_BUDGET_TOKENS = 5000;
/** …ou ce nombre d'étapes, si le modèle ne rend pas de compteurs. */
const TERMINAL_BUDGET_STEPS = 20;
/** Étapes reprises dans le résumé de passation d'un terminal au suivant. */
const HANDOFF_STEPS = 8;

const SYSTEM_PROMPT = [
  "You are sunflower's computer-driving hand. You run fully locally. The user asked you to finish ONE task on their Mac, and you start right away — they may well be sitting there watching you.",
  "You share the machine with them: your gestures are held back automatically whenever they touch the keyboard or mouse, so the screen may have moved on between your turns. Always judge from the image, never from what you expected.",
  "The attached image is the CURRENT screen. Decide the SINGLE next input action that moves the task forward.",
  'Reply with EXACTLY one JSON object, nothing else: {"action":"click"|"double-click"|"type"|"key"|"wait"|"done","x":0-1,"y":0-1,"text":"...","why":"short"}.',
  "x and y are fractions of the screen width and height (0-1) pointing at the CENTER of the target; they are required for click, double-click and type.",
  '"type" first clicks at x,y to focus the field, then types text.',
  `"key" presses one named key from: ${KEY_NAMES.join(", ")} (put the name in text). Use pagedown/pageup to scroll.`,
  '"wait" does nothing for a moment (screen still loading). "done" ends the run — use it as soon as the task is finished OR clearly impossible, and say which in why.',
  "Keep why under 10 words. Be conservative: never open apps you do not see, never touch system settings, never type passwords. One action per reply, no markdown, no prose outside the JSON.",
].join(" ");

// ---- Étape JSON du modèle -------------------------------------------------
const ACTIONS = [
  "click",
  "double-click",
  "type",
  "key",
  "wait",
  "done",
] as const;

interface WorkStep {
  action: WorkActionName;
  x?: number;
  y?: number;
  text?: string;
  why: string;
}

/** Supprime les blocs <think>…</think> (réponse non streamée, défensif). */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Extrait et valide l'unique objet JSON de la réponse ; null sinon. */
export function parseStep(raw: string): WorkStep | null {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const action = obj["action"];
  if (
    typeof action !== "string" ||
    !(ACTIONS as readonly string[]).includes(action)
  ) {
    return null;
  }
  const step: WorkStep = {
    action: action as WorkActionName,
    why: typeof obj["why"] === "string" ? obj["why"].trim().slice(0, 100) : "",
  };
  // Coordonnées hors [0,1] (pourcentages, pixels…) : réponse invalide, on
  // fait recommencer le modèle plutôt que de « clamper » vers un clic au
  // bord de l'écran qui n'a rien à voir avec sa cible.
  const x = obj["x"];
  if (typeof x === "number" && Number.isFinite(x)) {
    if (x < 0 || x > 1) return null;
    step.x = x;
  }
  const y = obj["y"];
  if (typeof y === "number" && Number.isFinite(y)) {
    if (y < 0 || y > 1) return null;
    step.y = y;
  }
  if (typeof obj["text"] === "string") step.text = obj["text"];
  const needsXY =
    step.action === "click" ||
    step.action === "double-click" ||
    step.action === "type";
  if (needsXY && (step.x === undefined || step.y === undefined)) return null;
  if (step.action === "type" && !step.text) return null;
  if (step.action === "key" && !step.text) return null;
  return step;
}

/** Trace courte d'une étape exécutée, resservie au modèle au tour suivant. */
function describe(step: WorkStep): string {
  const at =
    step.x !== undefined && step.y !== undefined
      ? ` at (${step.x.toFixed(2)}, ${step.y.toFixed(2)})`
      : "";
  const text =
    step.action === "type" || step.action === "key"
      ? ` "${(step.text ?? "").slice(0, 40)}"`
      : "";
  return `${step.action}${at}${text} — ${step.why || "no reason given"}`;
}

// ---- Un tour de modèle (vision, non streamé, borné) -----------------------
interface TurnResult {
  content: string;
  tokens: number;
}

async function modelTurn(
  task: string,
  handoff: string,
  history: string[],
  guidance: string[],
  shot: Screenshot,
  signal: AbortSignal,
): Promise<TurnResult> {
  const status = await checkOllama();
  if (!status.reachable) {
    throw new Error("ollama can't be reached — run ollama serve.");
  }
  if (!status.pulled) {
    throw new Error(`model missing — ollama pull ${status.name}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), turnTimeoutMs());
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: status.name,
        stream: false,
        think: false,
        format: "json",
        keep_alive: "10m",
        options: {
          temperature: 0.1,
          num_ctx: budget().numCtx,
          num_predict: budget().numPredict,
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `Task: ${task}`,
              "",
              ...(handoff
                ? ["Earlier in this run (previous context window):", handoff, ""]
                : []),
              "Actions already performed:",
              history.length > 0 ? history.join("\n") : "(none yet)",
              "",
              ...(guidance.length > 0
                ? [
                    "The user just told you, mid-run — follow this over your own plan:",
                    guidance.map((g) => `- ${g}`).join("\n"),
                    "",
                  ]
                : []),
              "The image is the CURRENT screen. Reply with the single next JSON action.",
            ].join("\n"),
            images: [shot.imageB64],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama responded ${res.status}.`);
    const data = (await res.json()) as {
      message?: { content?: string };
      error?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    if (data.error) throw new Error(`ollama: ${data.error}`);
    return {
      content: data.message?.content ?? "",
      tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Décharge le runner Ollama : le renouvellement de terminal doit JETER
 *  l'état accumulé, pas juste changer les messages envoyés. Silencieux. */
async function unloadModel(): Promise<void> {
  try {
    const status = await checkOllama();
    await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: status.name,
        messages: [],
        stream: false,
        keep_alive: 0,
      }),
    });
  } catch {
    // au pire, le tour suivant rechargera le modèle lui-même
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
    const aborted = () => id !== gen || signal.aborted;
    /** L'utilisateur a-t-il touché sa machine depuis la dernière étape ? Sert à
     *  jeter une décision prise sur une capture devenue périmée. */
    let userActive = false;
    let steps = 0;
    /** Étapes jetées parce que l'écran avait bougé sous le modèle — comptées
     *  pour que le message de fin dise la vérité si le budget y passe. */
    let dropped = 0;

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
      await waitForQuiet(QUIET_MS, signal);
      userActive = false;
      if (aborted()) return;
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
      let windowTokens = 0;
      let windowSteps = 0;
      let badReplies = 0;

      /** Ferme la fenêtre courante et en ouvre une neuve, état Ollama jeté. */
      const renewTerminal = async () => {
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
        await unloadModel();
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
          windowTokens >= TERMINAL_BUDGET_TOKENS ||
          windowSteps >= TERMINAL_BUDGET_STEPS
        ) {
          await renewTerminal();
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
        const guidance = store.drainGuidance(sessionId);
        if (guidance.length > 0) {
          log(sessionId, "info", `new instruction: ${guidance.join(" / ")}`);
        }
        const turn = await modelTurn(
          task,
          handoff,
          history,
          guidance,
          shot,
          signal,
        );
        if (aborted()) break;
        windowTokens += turn.tokens;
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
        // Étape annoncée : île + vignette « working » (casque + clé).
        deps.broadcast({
          island: "acting",
          pose: "working",
          message: step.why || describe(step),
        });
        log(sessionId, "step", `step ${i}: ${describe(step)}`);
        const record = store.pushCall(sessionId, {
          step: i,
          action: step.action,
          ...(step.x !== undefined ? { x: step.x } : {}),
          ...(step.y !== undefined ? { y: step.y } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          why: step.why,
          status: "running",
        });
        // CGEvents en POINTS : bornes du display Electron (points), jamais
        // la taille pixel de la capture (scaleFactor déjà hors jeu ici).
        const b = shot.display.bounds;
        const px = b.x + (step.x ?? 0) * b.width;
        const py = b.y + (step.y ?? 0) * b.height;
        try {
          if (step.action === "wait") {
            await sleep(SETTLE_MIN_MS + SETTLE_JITTER_MS, signal);
          } else if (step.action === "click") {
            await clickAt(px, py);
          } else if (step.action === "double-click") {
            await doubleClickAt(px, py);
          } else if (step.action === "type") {
            await clickAt(px, py);
            await sleep(300, signal);
            // La frappe s'interrompt entre deux tranches si l'utilisateur
            // reprend la main — on ne tape pas par-dessus lui.
            if (!aborted()) await typeText(step.text ?? "", () => userActive);
          } else {
            await pressKey(step.text ?? "");
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
        if (record) store.updateCall(sessionId, record.id, { status: "done" });
        steps++;
        windowSteps++;
        history.push(`${i}. ${describe(step)}`);
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
