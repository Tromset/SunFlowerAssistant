/** Sunflower Work : la fleur finit une corvée à votre place. Elle s'y met
 *  TOUT DE SUITE — plus besoin de quitter son bureau pour qu'un run démarre —
 *  et cède le curseur dès que vous touchez la machine. Un run de travail est
 *  une SESSION longue — pensée pour tourner des heures sur un modèle local —
 *  suivie pas à pas depuis l'app Work dédiée (liste des agents, chatbox,
 *  terminal, appels d'outils).
 *
 *  Module de types partagé main ↔ renderer : ni electron, ni node. */

export type WorkStatus =
  /** Créée, en file : un seul run pilote la souris à la fois. */
  | "queued"
  /** Attend que l'utilisateur s'éloigne du clavier. N'arrive QUE si
   *  `requiredIdleSec > 0` : par défaut le run démarre sans attendre. */
  | "waiting-idle"
  /** Boucle capture → décision → geste. */
  | "running"
  /** L'utilisateur se sert de sa machine : aucun geste ne part, le run reprend
   *  seul après une accalmie (`onUserInput: "pause"`). */
  | "paused"
  /** Terminée par le modèle (`done`). */
  | "done"
  /** Interrompue : retour de l'utilisateur, hotkey, annulation, opt-in coupé. */
  | "aborted"
  /** Butée (budget, permission, réponses hors format…). */
  | "failed";

export const WORK_ACTIVE_STATUSES: readonly WorkStatus[] = [
  "queued",
  "waiting-idle",
  "running",
  "paused",
] as const;

/** Les gestes que le modèle peut demander — un par tour, jamais plus.
 *  Le défilement passe par `key` (page down / page up), pas par un geste
 *  dédié : une molette synthétique fiable demanderait un binaire natif, alors
 *  qu'une touche marche partout et reste annulable au même titre. */
export type WorkActionName =
  | "click"
  | "double-click"
  | "type"
  | "key"
  | "wait"
  | "done";

/** Un appel d'outil : ce que le modèle a demandé, ce qui en est advenu. */
export interface WorkToolCall {
  /** Index stable dans la session. */
  id: number;
  /** Numéro d'étape affiché (1-based, continu à travers les renouvellements). */
  step: number;
  action: WorkActionName;
  /** Fractions d'écran 0..1 (clics et frappes) — absentes sinon. */
  x?: number;
  y?: number;
  /** Texte tapé, nom de touche, ou sens de défilement. */
  text?: string;
  /** La justification courte donnée par le modèle. */
  why: string;
  status: "running" | "done" | "error";
  /** Message d'erreur quand status === "error". */
  note?: string;
  at: number;
}

/** Ligne du flux terminal de la session (ce que le CLI aurait imprimé). */
export interface WorkLogLine {
  at: number;
  level: "info" | "step" | "warn" | "error";
  text: string;
}

/** Message de la chatbox : l'utilisateur guide, la fleur répond. */
export interface WorkChatMessage {
  at: number;
  role: "user" | "sunflower";
  text: string;
}

/** Une « fenêtre de terminal » de la session : le modèle repart d'un contexte
 *  neuf à chaque renouvellement, en gardant un résumé de ce qui précède.
 *  C'est ce qui permet à un run de durer bien plus longtemps que la fenêtre
 *  de contexte d'un petit modèle local. */
export interface WorkTerminal {
  /** 1-based : « terminal 3 » dans l'interface. */
  index: number;
  startedAt: number;
  endedAt?: number;
  /** Tokens consommés dans cette fenêtre (mesurés par Ollama). */
  tokens: number;
  /** Étapes exécutées dans cette fenêtre. */
  steps: number;
  /** Résumé transmis à la fenêtre suivante (vide pour la dernière en cours). */
  handoff?: string;
}

export interface WorkSession {
  id: string;
  task: string;
  status: WorkStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Message final (raison de l'arrêt, conclusion du modèle). */
  message?: string;
  /** Étapes exécutées, tous terminaux confondus. */
  steps: number;
  /** Fenêtres de contexte successives (au moins une dès le démarrage). */
  terminals: WorkTerminal[];
  calls: WorkToolCall[];
  log: WorkLogLine[];
  chat: WorkChatMessage[];
}

/** Version allégée pour la liste latérale de l'app Work. */
export interface WorkSessionSummary {
  id: string;
  task: string;
  status: WorkStatus;
  createdAt: number;
  finishedAt?: number;
  steps: number;
  terminals: number;
  message?: string;
}

/** Événements diffusés au fil du run (l'app Work rend chacun en direct). */
export type WorkEvent =
  | { kind: "created"; sessionId: string }
  | { kind: "status"; sessionId: string; status: WorkStatus; message?: string }
  | { kind: "log"; sessionId: string; line: WorkLogLine }
  | { kind: "call"; sessionId: string; call: WorkToolCall }
  | { kind: "chat"; sessionId: string; message: WorkChatMessage }
  /** Nouvelle fenêtre de contexte ouverte (« terminal » renouvelé). */
  | { kind: "terminal"; sessionId: string; terminal: WorkTerminal }
  /** La session a disparu de l'historique (purge). */
  | { kind: "removed"; sessionId: string };

/** Ce que fait un run quand l'utilisateur touche sa machine en pleine course.
 *  `pause` : plus aucun geste ne part, et le run reprend tout seul après une
 *  accalmie — c'est ce qui permet de démarrer sans attendre que le bureau soit
 *  vide. `stop` : le run s'annule sur-le-champ (comportement historique). */
export type WorkOnUserInput = "pause" | "stop";

export const WORK_ON_USER_INPUT: readonly WorkOnUserInput[] = [
  "pause",
  "stop",
] as const;

/** Réglages exposés dans l'app Work — bornés côté main, jamais crus sur parole. */
export interface WorkSettings {
  /** Autoriser Sunflower Work (miroir de `sunflowerWorkEnabled`). */
  enabled: boolean;
  /** Secondes d'inactivité exigées avant le premier geste. 0 (défaut) = on s'y
   *  met immédiatement, sans attendre que l'utilisateur s'éloigne. */
  requiredIdleSec: number;
  /** Minutes de budget total pour un run (0 = pas de limite de temps). */
  budgetMin: number;
  /** Étapes maximum par run. */
  maxSteps: number;
  /** Pause-et-reprise, ou arrêt net, quand l'utilisateur revient au clavier. */
  onUserInput: WorkOnUserInput;
}

export const WORK_SETTINGS_BOUNDS = {
  /** Plancher 0 : « démarre maintenant » est une valeur légitime, et le défaut. */
  requiredIdleSec: { min: 0, max: 300, def: 0 },
  budgetMin: { min: 0, max: 720, def: 120 },
  maxSteps: { min: 5, max: 2000, def: 300 },
} as const;

export const WORK_ON_USER_INPUT_DEF: WorkOnUserInput = "pause";

export function clampWorkSettings(
  patch: Partial<WorkSettings>,
  current: WorkSettings,
): WorkSettings {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  const b = WORK_SETTINGS_BOUNDS;
  return {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    requiredIdleSec: clamp(
      patch.requiredIdleSec ?? current.requiredIdleSec,
      b.requiredIdleSec.min,
      b.requiredIdleSec.max,
      current.requiredIdleSec,
    ),
    budgetMin: clamp(
      patch.budgetMin ?? current.budgetMin,
      b.budgetMin.min,
      b.budgetMin.max,
      current.budgetMin,
    ),
    maxSteps: clamp(
      patch.maxSteps ?? current.maxSteps,
      b.maxSteps.min,
      b.maxSteps.max,
      current.maxSteps,
    ),
    // Liste blanche : le renderer envoie une chaîne, on n'en accepte que deux.
    onUserInput: WORK_ON_USER_INPUT.includes(patch.onUserInput as WorkOnUserInput)
      ? (patch.onUserInput as WorkOnUserInput)
      : current.onUserInput,
  };
}
