import { contextBridge, ipcRenderer } from "electron";
import { CH, type MicErrorCode, type SunflowerBridge } from "../shared/ipc";
import type { PermissionId } from "../shared/state";
import type { SunflowerConfig } from "../shared/config-schema";
import type { OrbSource } from "../shared/orb";
import type { WorkSettings } from "../shared/work";
import type { CodeMode, CodePermission } from "../shared/code";

function on(
  channel: string,
  cb: (...args: unknown[]) => void,
): () => void {
  const listener = (_event: unknown, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: SunflowerBridge = {
  onState: (cb) => on(CH.state, cb as (...a: unknown[]) => void),
  onMicStart: (cb) => on(CH.micStart, cb),
  onMicStop: (cb) => on(CH.micStop, cb),
  onAnswerReset: (cb) => on(CH.answerReset, cb),
  onAnswerToken: (cb) => on(CH.answerToken, cb as (...a: unknown[]) => void),
  onAnswerDone: (cb) => on(CH.answerDone, cb as (...a: unknown[]) => void),
  onTtsStop: (cb) => on(CH.ttsStop, cb),
  onPointShow: (cb) => on(CH.pointShow, cb as (...a: unknown[]) => void),
  onGuideStep: (cb) => on(CH.guideStep, cb as (...a: unknown[]) => void),
  onPanelData: (cb) => on(CH.panelData, cb as (...a: unknown[]) => void),
  onFlip: (cb) => on(CH.flip, cb as (...a: unknown[]) => void),
  sendMicData: (pcm: Float32Array, sampleRate: number) =>
    ipcRenderer.send(CH.micData, { pcm, sampleRate }),
  sendMicError: (code: MicErrorCode) =>
    ipcRenderer.send(CH.micError, { code }),
  sendTtsEnded: () => ipcRenderer.send(CH.ttsEnded),
  getStatus: () => ipcRenderer.invoke(CH.statusGet),
  getPermissions: () => ipcRenderer.invoke(CH.permissionsGet),
  requestPermission: (id: PermissionId) =>
    ipcRenderer.invoke(CH.permissionsRequest, id),
  getConfig: () => ipcRenderer.invoke(CH.configGet),
  setConfig: (patch: Partial<SunflowerConfig>) =>
    ipcRenderer.invoke(CH.configSet, patch),
  downloadWhisper: () => ipcRenderer.invoke(CH.whisperDownload),
  onboardingDone: () => ipcRenderer.invoke(CH.onboardingDone),
  quit: () => ipcRenderer.invoke(CH.appQuit),
  // Petit rond du bord droit (voir main/windows/orb.ts).
  onOrbChanged: (cb) => on(CH.orbChanged, cb as (...a: unknown[]) => void),
  onOrbReset: (cb: () => void) =>
    on(CH.orbReset, cb as (...a: unknown[]) => void),
  orbHoverStart: () => ipcRenderer.send(CH.orbHoverStart),
  orbHoverEnd: () => ipcRenderer.send(CH.orbHoverEnd),
  orbDragStart: (screenY: number) =>
    ipcRenderer.send(CH.orbDragStart, screenY),
  orbDragMove: (screenY: number) => ipcRenderer.send(CH.orbDragMove, screenY),
  orbDragEnd: (screenY: number) => ipcRenderer.send(CH.orbDragEnd, screenY),
  orbOpen: (source: OrbSource) => ipcRenderer.invoke(CH.orbOpen, source),
  // Compagnon dockable (voir main/windows/companion.ts).
  onCompanionDocked: (cb) =>
    on(CH.companionDocked, cb as (...a: unknown[]) => void),
  companionSetHover: (hovering: boolean) =>
    ipcRenderer.send(CH.companionHover, hovering),
  companionToggleDock: () => ipcRenderer.invoke(CH.companionToggleDock),
  // Humeurs contextuelles du compagnon (voir shared/activity.ts).
  onActivity: (cb) => on(CH.activity, cb as (...a: unknown[]) => void),
  // Le panneau mesure sa carte et la fenêtre s'y ajuste.
  panelResize: (height: number) => ipcRenderer.send(CH.panelResize, height),
  // Sunflower Work : app dédiée + pilotage des sessions.
  onWorkChanged: (cb) => on(CH.workChanged, cb as (...a: unknown[]) => void),
  onWorkEvent: (cb) => on(CH.workEvent, cb as (...a: unknown[]) => void),
  workOpen: () => ipcRenderer.invoke(CH.workOpen),
  workList: () => ipcRenderer.invoke(CH.workList),
  workGet: (id: string) => ipcRenderer.invoke(CH.workGet, id),
  workStart: (task: string) => ipcRenderer.invoke(CH.workStart, task),
  workCancel: (id: string) => ipcRenderer.invoke(CH.workCancel, id),
  workChat: (id: string, text: string) =>
    ipcRenderer.invoke(CH.workChat, id, text),
  workSettingsGet: () => ipcRenderer.invoke(CH.workSettingsGet),
  workSettingsSet: (patch: Partial<WorkSettings>) =>
    ipcRenderer.invoke(CH.workSettingsSet, patch),
  // Sunflower-Code : app dédiée, branchée sur la session du terminal.
  onCodeEvent: (cb) => on(CH.codeEvent, cb as (...a: unknown[]) => void),
  codeOpen: () => ipcRenderer.invoke(CH.codeOpen),
  codeState: () => ipcRenderer.invoke(CH.codeState),
  codeSend: (text: string) => ipcRenderer.invoke(CH.codeSend, text),
  codeApprove: (callId: number, approved: boolean) =>
    ipcRenderer.invoke(CH.codeApprove, callId, approved),
  codeInterrupt: () => ipcRenderer.invoke(CH.codeInterrupt),
  codeClear: () => ipcRenderer.invoke(CH.codeClear),
  codeSetMode: (mode: CodeMode) => ipcRenderer.invoke(CH.codeSetMode, mode),
  codeSetPermission: (permission: CodePermission) =>
    ipcRenderer.invoke(CH.codeSetPermission, permission),
  codePickWorkdir: () => ipcRenderer.invoke(CH.codePickWorkdir),
  // Pont Claude Code : les sessions suivies, et l'onde de fin.
  onClaudeChanged: (cb) =>
    on(CH.claudeChanged, cb as (...a: unknown[]) => void),
  onClaudeFinished: (cb) =>
    on(CH.claudeFinished, cb as (...a: unknown[]) => void),
  claudeStatus: () => ipcRenderer.invoke(CH.claudeStatus),
  claudeSetEnabled: (on_: boolean) =>
    ipcRenderer.invoke(CH.claudeSetEnabled, on_),
};

contextBridge.exposeInMainWorld("sunflower", bridge);
