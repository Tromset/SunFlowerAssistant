/** Internal phases of the state machine (main process). */
export type AppPhase =
  | "idle"
  | "listening"
  | "processing"
  | "thinking"
  | "responding"
  | "guiding";

/** States displayed by the island (prototype surface 1c). */
export type IslandState =
  | "idle"
  | "listening"
  | "reading"
  | "thinking"
  | "acting"
  | "answering"
  | "guiding"
  | "error";

/** Poses of the sunflower companion (prototype surface 1d).
 *  Les trois dernières sont des « vignettes d'activité » (scènes animées) :
 *  - coding  : le tournesol avec un petit ordinateur portable (humeur « code »)
 *  - reading : loupe au-dessus d'un document (analyse de la capture d'écran)
 *  - working : tournesol casqué avec une clé (exécution d'outils/actions) */
export type CompanionPose =
  | "idle"
  | "listening"
  | "thinking"
  | "answering"
  | "pointing"
  | "coding"
  | "reading"
  | "working";

export type PermissionId =
  | "microphone"
  | "accessibility"
  | "screen"
  | "screenContent";

export type PermissionStatus = "granted" | "denied" | "not-determined";

export type SttStatus =
  | "ready"
  | "loading"
  | "downloading"
  | "absent"
  | "error"
  | "disabled";

export interface StatePayload {
  island: IslandState;
  pose: CompanionPose;
  /** Error message (`error` state) or action label. */
  message?: string;
}

export interface PanelData {
  permissions: Record<PermissionId, PermissionStatus>;
  model: {
    host: string;
    name: string;
    reachable: boolean;
    pulled: boolean;
  };
  stt: {
    status: SttStatus;
    /** Model download progress, 0..100. */
    progress?: number;
    error?: string;
    model: string;
  };
  hotkeyAvailable: boolean;
  version: string;
}
