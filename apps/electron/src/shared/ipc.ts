import type {
  PanelData,
  PermissionId,
  PermissionStatus,
  StatePayload,
} from "./state";
import type { SunflowerConfig } from "./config-schema";
import type { OrbRun, OrbSource } from "./orb";
import type { ActivitySnapshot } from "./activity";
import type {
  CodeAppEvent,
  CodeAppState,
  CodeMode,
  CodePermission,
} from "./code";
import type {
  WorkEvent,
  WorkSession,
  WorkSessionSummary,
  WorkSettings,
} from "./work";
import type {
  ClaudeChime,
  ClaudeStatus,
  ClaudeTask,
  ClaudeToggleResult,
} from "./claude";

/** Canaux main → renderer (webContents.send). */
export const CH = {
  state: "sf:state",
  micStart: "sf:mic-start",
  micStop: "sf:mic-stop",
  answerReset: "sf:answer-reset",
  answerToken: "sf:answer-token",
  answerDone: "sf:answer-done",
  ttsStop: "sf:tts-stop",
  pointShow: "sf:point-show",
  guideStep: "sf:guide-step",
  panelData: "sf:panel-data",
  flip: "sf:flip",
  // Ce que le rond affiche : les runs Code/Work en cours, déjà traduits en
  // texte lisible par le main (voir shared/orb.ts).
  orbChanged: "sf:orb:changed",
  // Le compagnon passe en badge docké (ou en sort) : le renderer compacte
  // sa mise en page (voir renderer/companion + windows/companion.ts).
  companionDocked: "sf:companion:docked",
  // Humeur contextuelle : app/site au premier plan rangé dans une famille
  // (musique, code, streaming…). Le compagnon en tire un accessoire, le
  // panneau l'affiche en clair. Voir shared/activity.ts.
  activity: "sf:activity",
  // Sunflower Work : liste des sessions et flux d'événements du run en cours.
  workChanged: "sf:work:changed",
  workEvent: "sf:work:event",
  // Sunflower-Code : flux du harnais vers son app dédiée. La session est UNE,
  // partagée avec le terminal.
  codeEvent: "sf:code:event",
  // Pont Claude Code : la liste des sessions suivies (panneau), et le signal
  // « Claude a terminé » que le compagnon traduit en onde orange + son.
  claudeChanged: "sf:claude:changed",
  claudeFinished: "sf:claude:finished",
  // renderer → main (send)
  micData: "sf:mic-data",
  micError: "sf:mic-error",
  ttsEnded: "sf:tts-ended",
  // Survol de la fleur : la fenêtre du compagnon (sinon traversée par la
  // souris) devient interactive le temps du survol, pour le double-clic.
  companionHover: "sf:companion:hover",
  // main → rond : replie pastille/glisser (fenêtre re-affichée).
  orbReset: "sf:orb:reset",
  // Glisser vertical du rond (voir windows/orb.ts).
  orbHoverStart: "sf:orb:hover-start",
  orbHoverEnd: "sf:orb:hover-end",
  orbDragStart: "sf:orb:drag-start",
  orbDragMove: "sf:orb:drag-move",
  orbDragEnd: "sf:orb:drag-end",
  // renderer → main (invoke)
  permissionsGet: "sf:permissions:get",
  permissionsRequest: "sf:permissions:request",
  statusGet: "sf:status:get",
  configGet: "sf:config:get",
  configSet: "sf:config:set",
  whisperDownload: "sf:whisper:download",
  onboardingDone: "sf:onboarding:done",
  appQuit: "sf:app:quit",
  // Clic franc sur le rond : ouvre l'app du run affiché (Code ou Work).
  orbOpen: "sf:orb:open",
  // Double-clic sur la fleur : bascule follow ↔ docked (persisté en config).
  companionToggleDock: "sf:companion:toggle-dock",
  // Le panneau mesure sa carte et demande à la fenêtre de s'ajuster : sans
  // ça, une carte plus haute que la fenêtre se fait rogner et perd ses coins
  // arrondis du bas (voir windows/panel.ts).
  panelResize: "sf:panel:resize",
  // Sunflower Work : l'app dédiée (fenêtre à part) et son pilotage.
  workOpen: "sf:work:open",
  workList: "sf:work:list",
  workGet: "sf:work:get",
  workStart: "sf:work:start",
  workCancel: "sf:work:cancel",
  workChat: "sf:work:chat",
  workSettingsGet: "sf:work:settings:get",
  workSettingsSet: "sf:work:settings:set",
  // Sunflower-Code : l'app dédiée (fenêtre à part) et son pilotage. Tout tape
  // dans la MÊME session que le terminal — d'où l'absence d'identifiant.
  codeOpen: "sf:code:open",
  codeState: "sf:code:state",
  codeSend: "sf:code:send",
  codeApprove: "sf:code:approve",
  codeInterrupt: "sf:code:interrupt",
  codeClear: "sf:code:clear",
  codeSetMode: "sf:code:set-mode",
  codeSetPermission: "sf:code:set-permission",
  codePickWorkdir: "sf:code:pick-workdir",
  // Pont Claude Code : l'état du pont, et l'interrupteur. L'activation écrit
  // dans ~/.claude/settings.json, donc elle ne part QUE d'un geste explicite.
  claudeStatus: "sf:claude:status",
  claudeSetEnabled: "sf:claude:set-enabled",
} as const;

export interface MicDataPayload {
  pcm: Float32Array;
  sampleRate: number;
}

export type MicErrorCode = "denied" | "failed";

/** Taille intérieure du cadre de crochets (px fenêtre), envoyée avec
 *  CH.pointShow. Absente : visuel historique par défaut (100×60). */
export interface PointShowPayload {
  w?: number;
  h?: number;
}

/** Étape de guide annoncée au compagnon (bulle + voix). */
export interface GuideStepPayload {
  index: number;
  total: number;
  text: string;
  /** L'utilisateur a déjà agi : couper la voix en cours avant de parler. */
  cut: boolean;
}

type Unsubscribe = () => void;

/** Surface exposée aux renderers par le preload (window.sunflower). */
export interface SunflowerBridge {
  onState(cb: (s: StatePayload) => void): Unsubscribe;
  onMicStart(cb: () => void): Unsubscribe;
  onMicStop(cb: () => void): Unsubscribe;
  onAnswerReset(cb: () => void): Unsubscribe;
  onAnswerToken(cb: (text: string) => void): Unsubscribe;
  onAnswerDone(cb: (full: string) => void): Unsubscribe;
  onTtsStop(cb: () => void): Unsubscribe;
  onPointShow(cb: (p?: PointShowPayload) => void): Unsubscribe;
  onGuideStep(cb: (p: GuideStepPayload) => void): Unsubscribe;
  onPanelData(cb: (d: PanelData) => void): Unsubscribe;
  onFlip(cb: (side: "left" | "right") => void): Unsubscribe;
  /** Ce que le rond doit afficher : les runs Code/Work en cours. */
  onOrbChanged(cb: (runs: OrbRun[]) => void): Unsubscribe;
  /** Le compagnon vient d'être docké (true) ou libéré (false). */
  onCompanionDocked(cb: (docked: boolean) => void): Unsubscribe;
  /** Humeur contextuelle courante (app/site au premier plan classé). */
  onActivity(cb: (snapshot: ActivitySnapshot) => void): Unsubscribe;
  /** Sunflower Work : la liste des sessions a changé. */
  onWorkChanged(cb: (sessions: WorkSessionSummary[]) => void): Unsubscribe;
  /** Sunflower Work : événement fin du run (log, geste, chat, terminal). */
  onWorkEvent(cb: (ev: WorkEvent) => void): Unsubscribe;
  /** Sunflower-Code : événement fin du harnais (token, outil, accord, info). */
  onCodeEvent(cb: (ev: CodeAppEvent) => void): Unsubscribe;
  /** Pont Claude Code : les sessions suivies ont changé (panneau). */
  onClaudeChanged(cb: (tasks: ClaudeTask[]) => void): Unsubscribe;
  /** Pont Claude Code : Claude a terminé — onde orange et petit son. */
  onClaudeFinished(cb: (chime: ClaudeChime) => void): Unsubscribe;
  sendMicData(pcm: Float32Array, sampleRate: number): void;
  sendMicError(code: MicErrorCode): void;
  sendTtsEnded(): void;
  getStatus(): Promise<PanelData>;
  getPermissions(): Promise<Record<PermissionId, PermissionStatus>>;
  requestPermission(id: PermissionId): Promise<void>;
  getConfig(): Promise<SunflowerConfig>;
  setConfig(patch: Partial<SunflowerConfig>): Promise<SunflowerConfig>;
  downloadWhisper(): Promise<void>;
  onboardingDone(): Promise<void>;
  quit(): Promise<void>;
  // Petit rond docké au bord droit de l'écran, visible uniquement le temps
  // qu'un run Code ou Work tourne — voir windows/orb.ts.
  /** Fenêtre du rond ré-affichée repliée : resynchroniser l'état visuel. */
  onOrbReset(cb: () => void): void;
  orbHoverStart(): void;
  orbHoverEnd(): void;
  orbDragStart(screenY: number): void;
  orbDragMove(screenY: number): void;
  orbDragEnd(screenY: number): void;
  /** Clic (sans glisser) : ouvre l'app du run affiché. */
  orbOpen(source: OrbSource): Promise<void>;
  /** Survol de la fleur (companion) : rend la fenêtre interactive ou non. */
  companionSetHover(hovering: boolean): void;
  /** Double-clic sur la fleur : bascule follow ↔ docked. */
  companionToggleDock(): Promise<void>;
  /** Hauteur réelle de la carte du panneau, en px CSS : la fenêtre s'y ajuste
   *  pour que les coins arrondis du bas ne soient jamais rognés. */
  panelResize(height: number): void;
  // ---- Sunflower Work (app dédiée) --------------------------------------
  /** Ouvre (ou ramène au premier plan) la fenêtre Sunflower Work. */
  workOpen(): Promise<void>;
  workList(): Promise<WorkSessionSummary[]>;
  workGet(id: string): Promise<WorkSession | null>;
  /** Enfile une tâche ; null si refusée (opt-in absent, plateforme…). */
  workStart(task: string): Promise<WorkSessionSummary | null>;
  workCancel(id: string): Promise<void>;
  /** Message de la chatbox : consigne envoyée au run en cours. */
  workChat(id: string, text: string): Promise<void>;
  workSettingsGet(): Promise<WorkSettings>;
  workSettingsSet(patch: Partial<WorkSettings>): Promise<WorkSettings>;
  // ---- Sunflower-Code (app dédiée) --------------------------------------
  // Une seule session, la même que celle du terminal : aucune méthode ne
  // prend d'identifiant, et ce qui est tapé ici sort aussi là-bas.
  /** Ouvre (ou ramène au premier plan) la fenêtre Sunflower-Code. */
  codeOpen(): Promise<void>;
  /** Instantané complet : la fenêtre s'ouvre tard, souvent après coup. */
  codeState(): Promise<CodeAppState>;
  codeSend(text: string): Promise<void>;
  /** Accord d'outil. `callId` désigne l'appel : un clic en retard sur un
   *  accord déjà tranché (au terminal, par exemple) tombe dans le vide. */
  codeApprove(callId: number, approved: boolean): Promise<void>;
  codeInterrupt(): Promise<void>;
  codeClear(): Promise<void>;
  codeSetMode(mode: CodeMode): Promise<void>;
  codeSetPermission(permission: CodePermission): Promise<void>;
  /** Sélecteur de dossier natif (feuille attachée à la fenêtre) ; rend le
   *  dossier retenu, ou null si annulé ou refusé. */
  codePickWorkdir(): Promise<string | null>;
  // ---- Pont Claude Code -------------------------------------------------
  claudeStatus(): Promise<ClaudeStatus>;
  /** Interrupteur du pont. Activer écrit un bloc de hooks dans
   *  ~/.claude/settings.json, couper le retire : d'où le retour détaillé,
   *  que l'appelant affiche tel quel. */
  claudeSetEnabled(on: boolean): Promise<ClaudeToggleResult>;
}

declare global {
  interface Window {
    sunflower: SunflowerBridge;
  }
}
