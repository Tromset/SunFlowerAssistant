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
   *  petit rond des agents, ancré au bord droit — persistée après un glisser
   *  (voir main/windows/agent-orb.ts). */
  agentOrbY: number;
  /** Compagnon : « follow » (suit le curseur, historique) ou « docked »
   *  (petit badge garé en bas à droite — regarder une vidéo sans tournesol
   *  au milieu de l'écran). Voir main/windows/companion.ts. */
  companionMode: "follow" | "docked";
  /** Sunflower Work (expérimental) : autoriser la fleur à piloter souris et
   *  clavier pour une corvée demandée, quand l'utilisateur s'est éloigné.
   *  FAUX par défaut — opt-in explicite via le menu du tray.
   *  Voir main/work/runner.ts. */
  sunflowerWorkEnabled: boolean;
  /** Secondes d'inactivité exigées avant le premier geste d'un run de travail. */
  workRequiredIdleSec: number;
  /** Budget total d'un run de travail, en minutes (0 = illimité — Work est
   *  fait pour tourner longtemps sur un modèle local). */
  workBudgetMin: number;
  /** Étapes maximum par run de travail. */
  workMaxSteps: number;
  /** Humeurs contextuelles : le tournesol se donne un petit accessoire selon
   *  l'app au premier plan (casque, popcorn, plaid…). Purement décoratif et
   *  100 % local — voir shared/activity.ts. */
  moodsEnabled: boolean;
  /** Sunflower-Code : niveau de permission par défaut du harnais de codage
   *  du CLI (« plan » lecture seule, « normal » demande, « yolo » libre). */
  codePermission: "plan" | "normal" | "yolo";
  /** Sunflower-Code : mode de départ du CLI (code / chat / vision / plan). */
  codeMode: "code" | "chat" | "vision" | "plan";
}

export const DEFAULT_CONFIG: SunflowerConfig = {
  onboarded: false,
  ollamaHost: "http://localhost:11434",
  ollamaModel: "qwen3-vl:8b",
  whisperModel: "ggml-small-q5_1.bin",
  screenCaptureConfirmed: false,
  agentOrbY: 0.5,
  companionMode: "follow",
  sunflowerWorkEnabled: false,
  workRequiredIdleSec: 20,
  workBudgetMin: 120,
  workMaxSteps: 300,
  moodsEnabled: true,
  codePermission: "normal",
  codeMode: "code",
};
