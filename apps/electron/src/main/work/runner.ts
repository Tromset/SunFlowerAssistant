// Sunflower Work : la fleur pilote l'ordinateur pour une corvée non-code
// (« archive les newsletters »), UNIQUEMENT quand l'utilisateur s'est éloigné.
//
// Boucle lente et bornée : capture d'écran → un tour de modèle vision qui rend
// EXACTEMENT une étape JSON → validation/clamp → garde de présence →
// exécution via clicker.ts (CGEvents en points) → pause de stabilisation →
// recommencer. Tout est révocable à l'instant : la moindre entrée réelle
// (presence.ts), le hotkey, une interruption de la machine à états ou la
// fermeture de l'app tuent l'osascript en vol et la requête.
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
/** S'il reste au clavier au-delà, le run s'annule sans bruit. */
const WAIT_MAX_MS = 120_000;
const WAIT_POLL_MS = 1000;
const TURN_TIMEOUT_MS = 90_000;
/** Pause de stabilisation entre deux gestes (l'UI doit retomber). */
const SETTLE_MIN_MS = 1500;
const SETTLE_JITTER_MS = 1000;
/** Réponses hors format tolérées d'affilée avant d'abandonner. */
const MAX_BAD_REPLIES = 3;
// Même contexte que le tchat écran ; une étape JSON tient dans très peu de
// tokens (num_predict court = un tour raté coûte peu de temps).
const NUM_CTX = 8192;
const NUM_PREDICT = 220;
/** Tokens consommés dans une fenêtre avant de la renouveler. Volontairement
 *  bien sous NUM_CTX : ce qui dégrade un petit modèle vision, c'est l'état
 *  accumulé du runner, pas seulement le dépassement de fenêtre. */
const TERMINAL_BUDGET_TOKENS = 5000;
/** …ou ce nombre d'étapes, si le modèle ne rend pas de compteurs. */
const TERMINAL_BUDGET_STEPS = 20;
/** Étapes reprises dans le résumé de passation d'un terminal au suivant. */
const HANDOFF_STEPS = 8;

const SYSTEM_PROMPT = [
  "You are sunflower's computer-driving hand. You run fully locally. The user stepped away and asked you to finish ONE task on their Mac.",
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
  const timer = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);
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
          num_ctx: NUM_CTX,
          num_predict: NUM_PREDICT,
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
    let steps = 0;
    try {
      // -- Phase d'attente : on ne bouge pas tant que l'utilisateur est là.
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
      while (idleMs() < requiredIdleMs) {
        if (aborted()) {
          finish(id, sessionId, {
            status: "aborted",
            task,
            message: cancelReason ?? "cancelled.",
            steps,
          });
          return;
        }
        if (Date.now() - t0 >= WAIT_MAX_MS) {
          finish(id, sessionId, {
            status: "aborted",
            task,
            message: "you stayed at the keyboard — nothing was touched.",
            steps,
          });
          return;
        }
        await sleep(WAIT_POLL_MS, signal);
      }
      // -- L'utilisateur est parti : la moindre entrée réelle annule tout.
      unsubInput = onRealInput(() =>
        abort("you came back — hands off, all yours."),
      );
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
            if (!aborted()) await typeText(step.text ?? "");
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
        message: `step budget spent (${maxSteps}) without finishing.`,
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
