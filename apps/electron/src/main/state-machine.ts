// Session orchestrator: idle → listening → reading → thinking → answering,
// plus guiding when the model returns a step plan. One flight at a time
// (monotonic sessionId); every async continuation checks it is not stale
// before acting.
import type { Display } from "electron";
import type { AppPhase, StatePayload } from "../shared/state";
import type { GuideStepPayload, MicErrorCode } from "../shared/ipc";
import {
  OllamaFailure,
  OllamaUserInterrupt,
  type ChatOptions,
} from "./ollama";
import {
  createAnswerParser,
  stripMarkers,
  type ParsedGuide,
  type PointEvent,
} from "./guide-parser";
import type { GuideCallbacks } from "./guide-runner";
import type { Screenshot } from "./screenshot";

/** Source d'une question : dictée au micro ou tapée dans le terminal. */
export type QuestionSource = "voice" | "typed";

export interface MachineDeps {
  broadcast(payload: StatePayload): void;
  micStart(): void;
  micStop(): void;
  capture(): Promise<Screenshot | null>;
  transcribe(pcm: Float32Array, sampleRate: number): Promise<string>;
  sttReady(): boolean;
  screenGranted(): boolean;
  chat(opts: ChatOptions): Promise<string>;
  answerReset(): void;
  answerToken(text: string): void;
  answerDone(full: string): void;
  ttsStop(): void;
  showPoint(point: PointEvent, display: Display): void;
  hidePoint(): void;
  /** Lance l'exécution scriptée d'un plan de guide (guide-runner). */
  guideStart(guide: ParsedGuide, display: Display, cb: GuideCallbacks): void;
  /** Annule le guide en cours (idempotent). */
  guideCancel(): void;
  /** Étape annoncée : bulle + voix du compagnon, ligne terminal. */
  guideStep(payload: GuideStepPayload): void;
  /** Sunflower Work (pilotage souris/clavier) : opt-in de la config ? */
  workEnabled(): boolean;
  /** Confie une tâche [WORK:…] au work runner (voir work/runner.ts).
   *  Faux = refusée (un run déjà en cours, garde de présence absente…). */
  workStart(task: string): boolean;
  /** Double vérification du pointage : simulation invisible (encadrement DOM
   *  de l'app au premier plan, sinon second passage vision sur un zoom) qui
   *  corrige les coordonnées AVANT tout affichage. Doit résoudre avec le
   *  point à montrer — corrigé ou original. Absente : affichage direct. */
  resolvePoint?(
    point: PointEvent,
    shot: Screenshot,
    question: string,
    answer: string,
    signal: AbortSignal,
  ): Promise<PointEvent>;
  /** Cale les étapes d'un guide sur le DOM de l'app au premier plan (boîtes
   *  exactes des éléments visibles) avant l'exécution scriptée. Absente ou en
   *  échec : plan inchangé. */
  refineGuide?(
    guide: ParsedGuide,
    shot: Screenshot,
    signal: AbortSignal,
  ): Promise<ParsedGuide>;
  /** Question prête à partir (affichage terminal). */
  onQuestion?(question: string, source: QuestionSource): void;
  /** Détail d'une erreur de session (diagnostic terminal). */
  onSessionError?(context: "transcription" | "ollama", err: unknown): void;
  /** Diagnostic du pointage (marqueur brut → cadre), SUNFLOWER_DEBUG. */
  onPointerDebug?(line: string): void;
}

export interface SessionMachine {
  hotkeyDown(): void;
  hotkeyUp(): void;
  onMicData(pcm: Float32Array, sampleRate: number): void;
  onMicError(code: MicErrorCode): void;
  onTtsEnded(): void;
  interrupt(): void;
  /** Question tapée au terminal : capture immédiate puis pipeline partagé
   *  (sans STT). Retourne false si vide ou si une session est en cours —
   *  sauf pendant un guide, qu'elle annule pour repartir normalement. */
  askText(question: string): boolean;
  /** Une session est-elle en cours ? (décision Ctrl+C du terminal) */
  busy(): boolean;
}

const MIN_HOLD_MS = 300;
const ERROR_MS = 2600;
const TTS_FAILSAFE_MS = 90_000;
// Miroir local de POINTER_MS (windows/pointer.ts) : durée d'affichage d'un cadre
// non-collant avant auto-masquage. Dupliqué à dessein — state-machine.ts reste
// sans dépendance Electron (pointer.ts importe electron). Garder synchronisé.
const POINTER_LIVE_MS = 4000;

export function createSessionMachine(deps: MachineDeps): SessionMachine {
  let phase: AppPhase = "idle";
  let seq = 0;
  /** Last session whose mic audio was already consumed (one-shot). */
  let micSeen = -1;
  let abort: AbortController | null = null;
  let pressedAt = 0;
  let capturePromise: Promise<Screenshot | null> | null = null;
  let errorTimer: NodeJS.Timeout | null = null;
  let failsafeTimer: NodeJS.Timeout | null = null;
  let pointPoseTimer: NodeJS.Timeout | null = null;
  let micTimer: NodeJS.Timeout | null = null;
  /** Un cadre de pointage est-il affiché pour le tour courant ? Gate du
   *  raffinement : une correction qui résout après l'auto-masquage ne doit PAS
   *  faire resurgir un cadre. */
  let pointerLive = false;

  const clearTimers = () => {
    for (const t of [errorTimer, failsafeTimer, pointPoseTimer, micTimer]) {
      if (t) clearTimeout(t);
    }
    errorTimer = failsafeTimer = pointPoseTimer = micTimer = null;
    pointerLive = false;
  };

  const toIdle = () => {
    phase = "idle";
    clearTimers();
    deps.broadcast({ island: "idle", pose: "idle" });
  };

  const fail = (message: string) => {
    const id = ++seq;
    phase = "idle";
    clearTimers();
    // Voice, pointer and guide must never survive an error.
    deps.guideCancel();
    deps.ttsStop();
    deps.hidePoint();
    deps.broadcast({ island: "error", pose: "idle", message });
    errorTimer = setTimeout(() => {
      if (id === seq) toIdle();
    }, ERROR_MS);
  };

  const interrupt = () => {
    abort?.abort();
    abort = null;
    deps.guideCancel();
    deps.ttsStop();
    deps.hidePoint();
    clearTimers();
  };

  const runSession = async (
    id: number,
    pcm: Float32Array,
    sampleRate: number,
  ) => {
    const shot = await capturePromise;
    if (id !== seq) return;
    if (!shot) {
      fail("screen capture failed — check the permission.");
      return;
    }
    let question: string;
    try {
      question = await deps.transcribe(pcm, sampleRate);
    } catch (err) {
      deps.onSessionError?.("transcription", err);
      if (id === seq) fail("transcription failed.");
      return;
    }
    if (id !== seq) return;
    if (!question) {
      fail("I didn't hear anything.");
      return;
    }
    await runQuestion(id, question, shot, "voice");
  };

  /** Cœur partagé voix/clavier : stream Ollama → parseur POINT → réponse. */
  const runQuestion = async (
    id: number,
    question: string,
    shot: Screenshot,
    source: QuestionSource,
  ) => {
    deps.onQuestion?.(question, source);
    phase = "thinking";
    deps.broadcast({ island: "thinking", pose: "thinking" });
    deps.answerReset();
    const ctrl = new AbortController();
    abort = ctrl;
    // Texte déjà streamé de la réponse : contexte de la double vérification
    // (le second passage doit savoir DE QUOI parlait le pointage).
    let spoken = "";
    const showPoint = (point: PointEvent) => {
      if (id !== seq) return;
      deps.showPoint(point, shot.display);
      deps.broadcast({ island: "answering", pose: "pointing" });
      pointerLive = true;
      if (pointPoseTimer) clearTimeout(pointPoseTimer);
      pointPoseTimer = setTimeout(() => {
        // Fenêtre visible finie : le cadre s'est auto-masqué (miroir de
        // pointer.ts) — plus aucun raffinement ne doit le redessiner.
        pointerLive = false;
        if (id === seq && phase === "responding") {
          deps.broadcast({ island: "answering", pose: "answering" });
        }
      }, POINTER_LIVE_MS);
    };
    const parser = createAnswerParser(
      {
        onText: (text) => {
          if (id !== seq) return;
          spoken += text;
          deps.answerToken(text);
        },
        onPoint: (point) => {
          if (id !== seq) return;
          // Affichage optimiste : la boîte du modèle (déjà normalisée/saine) est
          // montrée TOUT DE SUITE — l'encadrement redevient instantané et fiable,
          // sans attendre la chaîne asynchrone (DOM osascript + éventuel second
          // passage vision). La double vérification ne fait plus que RAFFINER le
          // cadre en place.
          showPoint(point);
          if (!deps.resolvePoint) return;
          deps.resolvePoint(point, shot, question, spoken, ctrl.signal).then(
            (p) => {
              // Re-dessin UNIQUEMENT si (a) la vérif a réellement corrigé le point
              // (nouvel objet — contrat de verifyPoint : tout repli renvoie
              // l'original tel quel), (b) on est toujours sur le même tour, et
              // (c) le cadre est encore à l'écran. Sans (c), une correction
              // tardive (queue Ollama) ferait surgir un cadre après l'auto-masquage.
              if (p !== point && id === seq && pointerLive) showPoint(p);
            },
            () => {
              // verifyPoint ne rejette jamais (replis internes) ; garde par sûreté.
            },
          );
        },
      },
      {
        imageSize: shot.imageSize,
        debug: (line) => deps.onPointerDebug?.(line),
      },
    );
    let first = true;
    try {
      const full = await deps.chat({
        question,
        imageB64: shot.imageB64,
        signal: ctrl.signal,
        onToken: (text) => {
          if (id !== seq) return;
          if (first) {
            first = false;
            phase = "responding";
            deps.broadcast({ island: "answering", pose: "answering" });
          }
          parser.push(text);
        },
      });
      if (id !== seq) return;
      parser.flush();
      if (!full.trim()) {
        fail("I couldn't find anything to say.");
        return;
      }
      const work = parser.work();
      if (work !== null) {
        // Corvée d'ordinateur [WORK:…] : remise au work runner (opt-in ; il
        // s'y met tout de suite et rend le curseur dès qu'on s'en sert). La
        // session vocale, elle, se clôt sur la petite phrase d'annonce déjà
        // streamée par le modèle.
        phase = "responding";
        if (!deps.workEnabled()) {
          // Éteint par défaut : une phrase courte, et où l'allumer.
          deps.answerReset();
          const line =
            "sunflower work is off — enable it from the tray menu and ask me again.";
          deps.answerToken(line);
          deps.answerDone(line);
        } else if (!deps.workStart(work)) {
          // Refus (run déjà en cours, garde indisponible…) : le dire, plutôt
          // que d'acquiescer pour une tâche qui ne démarrera jamais.
          deps.answerReset();
          const line =
            "I couldn't start that — I'm probably already on another errand. ask me again in a bit.";
          deps.answerToken(line);
          deps.answerDone(line);
        } else {
          const ack = stripMarkers(full);
          if (ack) {
            deps.answerDone(ack);
          } else {
            const line = "on it — starting now.";
            deps.answerReset();
            deps.answerToken(line);
            deps.answerDone(line);
          }
        }
        failsafeTimer = setTimeout(() => {
          if (id === seq) {
            deps.ttsStop();
            toIdle();
          }
        }, TTS_FAILSAFE_MS);
        return;
      }
      deps.answerDone(stripMarkers(full));
      const guide = parser.guide();
      if (guide) {
        // Plan complet reçu : exécution scriptée, plus aucun appel IA entre
        // les étapes. Juste avant, l'encadrement DOM cale les boîtes des
        // étapes visibles sur les éléments HTML réels (échec = plan inchangé).
        phase = "guiding";
        let plan = guide;
        if (deps.refineGuide) {
          try {
            plan = await deps.refineGuide(guide, shot, ctrl.signal);
          } catch {
            plan = guide;
          }
          if (id !== seq) return;
        }
        deps.guideStart(plan, shot.display, {
          onStep: (index, total, step, cut) => {
            if (id !== seq) return;
            deps.broadcast({
              island: "guiding",
              pose: "pointing",
              message: `step ${index} of ${total}`,
            });
            deps.guideStep({ index, total, text: step.text, cut });
          },
          onEnd: (reason) => {
            if (id !== seq) return;
            if (reason === "completed") {
              // La clôture emprunte la voie normale de réponse.
              phase = "responding";
              deps.broadcast({ island: "answering", pose: "answering" });
              deps.answerReset();
              const bye = plan.outro ?? "All done.";
              deps.answerToken(bye);
              deps.answerDone(bye);
              failsafeTimer = setTimeout(() => {
                if (id === seq) {
                  deps.ttsStop();
                  toIdle();
                }
              }, TTS_FAILSAFE_MS);
            } else {
              deps.ttsStop();
              toIdle();
            }
          },
        });
        return;
      }
      phase = "responding";
      failsafeTimer = setTimeout(() => {
        if (id === seq) {
          deps.ttsStop();
          toIdle();
        }
      }, TTS_FAILSAFE_MS);
    } catch (err) {
      if (id !== seq || err instanceof OllamaUserInterrupt) return;
      deps.onSessionError?.("ollama", err);
      fail(
        err instanceof OllamaFailure
          ? err.userMessage
          : "something went wrong.",
      );
    }
  };

  return {
    hotkeyDown() {
      if (phase !== "idle" && phase !== "listening") interrupt();
      seq++;
      if (phase === "listening") return;
      if (!deps.sttReady()) {
        fail("voice unavailable — open the sunflower panel.");
        return;
      }
      clearTimers();
      phase = "listening";
      pressedAt = Date.now();
      deps.broadcast({ island: "listening", pose: "listening" });
      deps.micStart();
    },
    hotkeyUp() {
      if (phase !== "listening") return;
      if (Date.now() - pressedAt < MIN_HOLD_MS) {
        seq++;
        deps.micStop();
        toIdle();
        return;
      }
      if (!deps.screenGranted()) {
        seq++;
        deps.micStop();
        fail("allow screen recording in the sunflower panel.");
        return;
      }
      // Capture immediately: the screen is still in the state the user describes.
      capturePromise = deps.capture();
      phase = "processing";
      // Vignette « reading » : loupe au-dessus d'un document pendant l'analyse
      // de la capture d'écran.
      deps.broadcast({ island: "reading", pose: "reading" });
      deps.micStop();
      const id = seq;
      micTimer = setTimeout(() => {
        if (id === seq && phase === "processing") {
          fail("the mic sent nothing.");
        }
      }, 10_000);
    },
    onMicData(pcm, sampleRate) {
      // One-shot per session: a second micData (a late-cancelled session,
      // a duplicate) must never launch a second runSession with the same seq.
      if (phase !== "processing" || micSeen === seq) return;
      micSeen = seq;
      if (micTimer) {
        clearTimeout(micTimer);
        micTimer = null;
      }
      void runSession(seq, pcm, sampleRate);
    },
    onMicError(code) {
      if (phase !== "listening" && phase !== "processing") return;
      seq++;
      fail(
        code === "denied"
          ? "allow the microphone in the sunflower panel."
          : "the mic didn't respond.",
      );
    },
    onTtsEnded() {
      if (phase === "responding") toIdle();
    },
    interrupt() {
      seq++;
      interrupt();
      toIdle();
    },
    askText(question) {
      const q = question.trim();
      if (!q || (phase !== "idle" && phase !== "guiding")) return false;
      // Une question tapée en plein guide l'annule et repart normalement.
      if (phase === "guiding") interrupt();
      if (!deps.screenGranted()) {
        fail("allow screen recording in the sunflower panel.");
        return true; // pris en charge : l'erreur s'affiche
      }
      const id = ++seq;
      clearTimers();
      phase = "processing";
      // Vignette « reading » : loupe au-dessus d'un document pendant l'analyse
      // de la capture d'écran.
      deps.broadcast({ island: "reading", pose: "reading" });
      // Capture immédiate, sans toucher capturePromise/micSeen (voie vocale).
      void (async () => {
        const shot = await deps.capture();
        if (id !== seq) return;
        if (!shot) {
          fail("screen capture failed — check the permission.");
          return;
        }
        await runQuestion(id, q, shot, "typed");
      })();
      return true;
    },
    busy() {
      return phase !== "idle";
    },
  };
}
