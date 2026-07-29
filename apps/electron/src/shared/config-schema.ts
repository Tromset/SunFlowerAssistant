import type { Effort } from "./effort";

export interface SunflowerConfig {
  onboarded: boolean;
  ollamaHost: string;
  ollamaModel: string;
  /** Nom du fichier ggml sur huggingface (ggerganov/whisper.cpp). */
  whisperModel: string;
  /** Vrai dès qu'une capture d'écran a réussi — survit au redémarrage exigé
   *  par macOS après l'octroi de l'enregistrement d'écran. */
  screenCaptureConfirmed: boolean;
  /** Position verticale (0..1, du haut vers le bas de l'écran principal) du
   *  petit rond ancré au bord droit — persistée après un glisser
   *  (voir main/windows/orb.ts). */
  orbY: number;
  /** Compagnon : « follow » (suit le curseur, historique) ou « docked »
   *  (petit badge garé en bas à droite — regarder une vidéo sans tournesol
   *  au milieu de l'écran). Voir main/windows/companion.ts. */
  companionMode: "follow" | "docked";
  /** Sunflower Work (expérimental) : autoriser la fleur à piloter souris et
   *  clavier pour une corvée demandée. FAUX par défaut — opt-in explicite via
   *  le menu du tray. Voir main/work/runner.ts. */
  sunflowerWorkEnabled: boolean;
  /** Secondes d'inactivité exigées avant le premier geste d'un run de travail.
   *  0 (défaut) = on s'y met tout de suite, sans attendre un bureau vide ;
   *  c'est `workOnUserInput` qui évite alors de se battre pour le curseur. */
  workRequiredIdleSec: number;
  /** Budget total d'un run de travail, en minutes (0 = illimité — Work est
   *  fait pour tourner longtemps sur un modèle local). */
  workBudgetMin: number;
  /** Étapes maximum par run de travail. */
  workMaxSteps: number;
  /** Quand l'utilisateur touche sa machine pendant un run : « pause » (défaut,
   *  le run rend le curseur et reprend après une accalmie) ou « stop »
   *  (annulation immédiate — l'ancien comportement). Voir shared/work.ts. */
  workOnUserInput: "pause" | "stop";
  /** Humeurs contextuelles : le tournesol se donne un petit accessoire selon
   *  l'app au premier plan (casque, popcorn, plaid…). Purement décoratif et
   *  100 % local — voir shared/activity.ts. */
  moodsEnabled: boolean;
  /** Sunflower-Code : niveau de permission par défaut du harnais de codage
   *  du CLI (« plan » lecture seule, « normal » demande, « yolo » libre). */
  codePermission: "plan" | "normal" | "yolo";
  /** Sunflower-Code : mode de départ du CLI (code / chat / vision / plan). */
  codeMode: "code" | "chat" | "vision" | "plan";
  /** Pont vers Claude Code : suivre les sessions qui tournent dans un terminal
   *  à côté, et signaler quand Claude a fini. FAUX par défaut — activer écrit
   *  un bloc de hooks dans ~/.claude/settings.json, ce qui est un fichier de
   *  l'utilisateur : l'accord passe par le menu du tray. Voir main/claude/. */
  claudeWatchEnabled: boolean;
  /** Le petit son qui accompagne l'onde orange quand Claude a terminé. Se
   *  coupe sans couper l'onde. N'a de sens que si le pont est actif. */
  claudeChimeEnabled: boolean;
  /** Combien de tokens et de tours SunFlower s'autorise par tâche. « medium »
   *  reproduit exactement les budgets historiques — voir shared/effort.ts. */
  effort: Effort;
  /** Plafond de temps par tâche, en minutes (0 = aucun). Posé par `/effort 20m`,
   *  appliqué en coupant l'AbortController du tour en cours. */
  effortDeadlineMin: number;
}

export const DEFAULT_CONFIG: SunflowerConfig = {
  onboarded: false,
  ollamaHost: "http://localhost:11434",
  ollamaModel: "qwen3-vl:8b",
  whisperModel: "ggml-small-q5_1.bin",
  screenCaptureConfirmed: false,
  orbY: 0.5,
  companionMode: "follow",
  sunflowerWorkEnabled: false,
  workRequiredIdleSec: 0,
  workBudgetMin: 120,
  workMaxSteps: 300,
  workOnUserInput: "pause",
  moodsEnabled: true,
  codePermission: "normal",
  codeMode: "code",
  claudeWatchEnabled: false,
  claudeChimeEnabled: true,
  effort: "medium",
  effortDeadlineMin: 0,
};
