import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeImage,
  screen,
} from "electron";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CH, type MicDataPayload, type MicErrorCode } from "../shared/ipc";
import type { PanelData, PermissionId, StatePayload } from "../shared/state";
import type { OrbRun, OrbSource } from "../shared/orb";
import type { ActivitySnapshot } from "../shared/activity";
import {
  CODE_COMPACT_AT_TOKENS,
  CODE_MODES,
  CODE_PERMISSIONS,
  codeMaxTurns,
  type CodeAppEvent,
  type CodeMode,
  type CodePermission,
  type CodeSessionInfo,
} from "../shared/code";
import {
  clampWorkSettings,
  WORK_ACTIVE_STATUSES,
  type WorkEvent,
  type WorkSessionSummary,
  type WorkSettings,
} from "../shared/work";
import { createActivityWatcher, type ActivityWatcher } from "./activity";
import { createClaudeWatcher, type ClaudeWatcher } from "./claude";
import {
  claudeStateLabel,
  type ClaudeStatus,
  type ClaudeTask,
} from "../shared/claude";
import { createCodeSession, type CodeSession } from "./code/session";
import { createCodeTranscript, type CodeTranscript } from "./code/transcript";
import { createWorkStore } from "./work/store";
import {
  openWorkWindow,
  releaseWorkWindow,
  workWindow,
} from "./windows/work";
import {
  createOrbController,
  createOrbWindow,
  type OrbController,
} from "./windows/orb";
import { getConfig, setConfig } from "./config-store";
import { readFrontmostDom } from "./dom-locator";
import { createGuideRunner } from "./guide-runner";
import { createPointVerifier } from "./point-verifier";
import {
  hotkeyAvailable,
  initHotkey,
  mouseHookAvailable,
  onGlobalMouseDown,
  stopHotkey,
} from "./hotkey";
import {
  availableModels,
  chat,
  checkOllama,
  ollamaHost,
  onContextReset,
  warmModel,
} from "./ollama";
import { formatBytes, pullModel, sameModel } from "../../lib/ollama-api.cjs";
import {
  EFFORTS,
  formatDeadline,
  parseEffort,
} from "../shared/effort";
import type { SunflowerConfig } from "../shared/config-schema";
import {
  permissionStatuses,
  requestPermission,
  screenGranted,
} from "./permissions";
import { captureScreenAtCursor } from "./screenshot";
import {
  createSessionMachine,
  type SessionMachine,
} from "./state-machine";
import {
  ensureStt,
  freeStt,
  onSttChange,
  sttReady,
  sttState,
  transcribe,
} from "./stt";
import { createTray, trayBounds } from "./tray";
import { CLI_MODES, createTui, type CliMode, type TuiStatusInfo } from "./tui";
import { createWatchdog } from "./watchdog";
import { createWorkRunner, type WorkRunner } from "./work/runner";
import {
  createCompanionController,
  createCompanionWindow,
  type CompanionController,
} from "./windows/companion";
import {
  codeWindow,
  openCodeWindow,
  releaseCodeWindow,
} from "./windows/code";
import { createIslandVisibility, createIslandWindow } from "./windows/island";
import { createOnboardingWindow } from "./windows/onboarding";
import { createPanelWindow, resizePanel, togglePanel } from "./windows/panel";
import {
  createPointerWindow,
  hidePointer,
  showPointerAt,
} from "./windows/pointer";

/** `sunflower code` : bin/sunflower.js traduit la sous-commande en ce
 *  drapeau avant de le passer à Electron, plutôt que de nous laisser deviner
 *  ce que veut dire un argument nu qui s'appelle « code ». */
const OPEN_CODE_FLAG = "--open-code";

/** `sunflower-code` passe le dossier depuis lequel on l'a lancé : le harnais
 *  démarre dans le projet où l'on se trouve, sans /cd d'ouverture. */
const WORKDIR_FLAG = "--cd";

function workdirFromArgv(argv: readonly string[]): string | null {
  const index = argv.indexOf(WORKDIR_FLAG);
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1] as string;
  const inline = argv.find((arg) => arg.startsWith(`${WORKDIR_FLAG}=`));
  return inline ? inline.slice(WORKDIR_FLAG.length + 1) : null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  // Traceur de ressources (CPU/RSS) en tâche de fond : pour attribuer un
  // futur pic (capture écran, whisper.cpp, fenêtre oubliée, Ollama emballé)
  // au lieu de deviner. Voir watchdog.ts pour les détails.
  const watchdog = createWatchdog();

  // Interface terminal (bannière, phases, saisie clavier). Sans TTY, simple
  // logs préfixés — l'app packagée ne change pas.
  const tui = createTui();
  const tuiInfo = (d: PanelData): TuiStatusInfo => ({
    host: d.model.host,
    model: d.model.name,
    reachable: d.model.reachable,
    pulled: d.model.pulled,
    whisperModel: d.stt.model,
    sttStatus: d.stt.status,
    hotkeyAvailable: d.hotkeyAvailable,
    version: d.version,
    codeWorkdir: codeSession?.info().workdir ?? process.cwd(),
    codePermission: getConfig().codePermission,
    workEnabled: getConfig().sunflowerWorkEnabled,
    effort: getConfig().effort,
    effortDeadlineMin: getConfig().effortDeadlineMin,
  });

  let island: BrowserWindow | null = null;
  let islandVisibility: ReturnType<typeof createIslandVisibility> | null =
    null;
  let companion: BrowserWindow | null = null;
  let pointer: BrowserWindow | null = null;
  let panel: BrowserWindow | null = null;
  let onboarding: BrowserWindow | null = null;
  let machine: SessionMachine | null = null;
  let companionCtl: CompanionController | null = null;
  let workRunner: WorkRunner | null = null;
  let orb: BrowserWindow | null = null;
  let orbCtl: OrbController | null = null;
  let activity: ActivityWatcher | null = null;
  let claude: ClaudeWatcher | null = null;
  let codeSession: CodeSession | null = null;
  let quitting = false;
  /** Dossier de départ du harnais : le cwd du terminal qui a lancé l'app.
   *  Suivi ici parce que la transcription est créée AVANT la session (les
   *  handlers IPC passent en premier) et doit pouvoir répondre entre-temps. */
  let codeWorkdir = process.cwd();
  /** Réévalue si le sondage d'humeur doit tourner. Remplacé une fois le
   *  compagnon et le guetteur créés ; en attendant, no-op (les handlers IPC
   *  sont enregistrés avant les fenêtres et peuvent déjà l'appeler). */
  let syncActivity: () => void = () => {};

  const sendTo = (
    win: BrowserWindow | null,
    channel: string,
    ...args: unknown[]
  ) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  // ---- Sunflower Work : registre des sessions + réglages ---------------
  // Le registre est créé tôt : les handlers IPC (enregistrés avant les
  // fenêtres) et l'app Work dédiée tapent tous les deux dedans.
  const sendWork = (channel: string, ...args: unknown[]) => {
    sendTo(panel, channel, ...args);
    sendTo(workWindow(), channel, ...args);
  };
  const workStore = createWorkStore((ev: WorkEvent) =>
    sendWork(CH.workEvent, ev),
  );

  // ---- Sunflower-Code : la transcription de LA session ------------------
  // Une seule session, partagée avec le terminal. La transcription est créée
  // tôt, comme le registre de Work : les handlers IPC passent avant les
  // fenêtres, et l'app peut demander son instantané dès son chargement.
  // Une seule cible, contrairement à sendWork : le panneau n'affiche rien du
  // harnais, et un flux de tokens envoyé à une fenêtre qui l'ignore, c'est du
  // travail pour rien à chaque mot que le modèle écrit.
  const sendCode = (channel: string, ...args: unknown[]) => {
    sendTo(codeWindow(), channel, ...args);
  };
  const codeTranscript: CodeTranscript = createCodeTranscript({
    info: () =>
      codeSession?.info() ?? {
        mode: getConfig().codeMode,
        permission: getConfig().codePermission,
        workdir: codeWorkdir,
        status: "idle",
        turns: 0,
        tokens: 0,
        messages: 0,
        maxTurns: codeMaxTurns(getConfig().effort),
        terminal: 1,
      },
    onEvent: (ev: CodeAppEvent) => sendCode(CH.codeEvent, ev),
  });

  /** Sélecteur de dossier natif. Attaché à la fenêtre Code quand elle existe :
   *  sur macOS ça donne une FEUILLE, pas une boîte flottante au milieu de
   *  l'écran. Le chemin ne quitte jamais le processus principal. */
  const pickProjectFolder = async (): Promise<string | null> => {
    const parent = codeWindow();
    const opts: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: codeSession?.info().workdir ?? codeWorkdir,
      message: "pick the project folder",
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled) return null;
    return res.filePaths[0] ?? null;
  };

  /**
   * LA fonction demandée par le TODO : tout ce que l'utilisateur tape au CLI
   * hors du mode « ask » part à Sunflower-Code. Un seul point de passage, donc
   * un seul endroit à regarder pour savoir où va un message — et l'app dédiée
   * passe par ici elle aussi, ce qui garde l'invariant vrai avec DEUX
   * surfaces au lieu d'une.
   */
  const routeToCode = (message: string): void => {
    if (!codeSession) {
      tui.warn("sunflower-code isn't ready yet.");
      return;
    }
    const text = message.trim();
    if (!text) return;
    // La session n'émet pas d'événement pour ce que l'utilisateur tape : sans
    // cette ligne, une question posée au terminal n'existerait pas dans l'app.
    codeTranscript.noteUser(text);
    void codeSession.send(text);
  };

  /** Change le dossier de projet — même porte que `/cd`, depuis les deux
   *  surfaces. Vide la conversation : c'est un autre projet. */
  const setCodeWorkdir = (dir: string): boolean => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    codeWorkdir = dir;
    codeSession?.setWorkdir(dir);
    codeTranscript.reset();
    codeTranscript.note(`project folder is now ${dir} — fresh conversation.`);
    return true;
  };
  const workSettings = (): WorkSettings => {
    const cfg = getConfig();
    return {
      enabled: cfg.sunflowerWorkEnabled,
      requiredIdleSec: cfg.workRequiredIdleSec,
      budgetMin: cfg.workBudgetMin,
      maxSteps: cfg.workMaxSteps,
      onUserInput: cfg.workOnUserInput,
    };
  };
  const saveWorkSettings = (patch: Partial<WorkSettings>): WorkSettings => {
    const next = clampWorkSettings(patch, workSettings());
    setConfig({
      sunflowerWorkEnabled: next.enabled,
      workRequiredIdleSec: next.requiredIdleSec,
      workBudgetMin: next.budgetMin,
      workMaxSteps: next.maxSteps,
      workOnUserInput: next.onUserInput,
    });
    return next;
  };

  // ---- Pont Claude Code : état et interrupteur -------------------------
  // Le réglage est la trace de l'INTENTION, l'installation est la vérité du
  // terrain : on ne les recolle jamais en douce, on montre l'écart.
  const claudeStatus = (): ClaudeStatus =>
    claude?.status() ?? {
      enabled: getConfig().claudeWatchEnabled,
      install: "absent",
      active: 0,
    };
  /** Le SEUL chemin qui écrit dans ~/.claude/settings.json, et il ne part que
   *  d'un geste explicite : case du tray, /claude on|off, panneau. */
  const setClaudeEnabled = (on: boolean) => {
    const result = claude?.setEnabled(on) ?? {
      ok: false,
      enabled: false,
      install: "absent" as const,
      problem: "Sunflower isn't ready yet.",
    };
    // On n'inscrit l'intention que si le geste a abouti : une case cochée
    // pendant que rien n'est installé mentirait au prochain démarrage.
    if (result.ok) setConfig({ claudeWatchEnabled: result.enabled });
    return result;
  };

  // ---- Statut agrégé (panneau + onboarding) ----------------------------
  const buildPanelData = async (): Promise<PanelData> => ({
    permissions: permissionStatuses(),
    model: await checkOllama(),
    stt: { ...sttState(), model: getConfig().whisperModel },
    hotkeyAvailable: hotkeyAvailable(),
    version: app.getVersion(),
  });

  let statusTimer: NodeJS.Timeout | null = null;
  const pushStatus = async () => {
    const targets = [panel, onboarding].filter(
      (w): w is BrowserWindow => !!w && !w.isDestroyed() && w.isVisible(),
    );
    if (targets.length === 0) return;
    const data = await buildPanelData();
    for (const w of targets) sendTo(w, CH.panelData, data);
  };
  const ensureStatusLoop = () => {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      void pushStatus();
      const anyVisible =
        (panel?.isVisible() ?? false) || (onboarding?.isVisible() ?? false);
      if (!anyVisible && statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
    }, 3000);
  };
  // onSttChange est mono-abonné : étendre CE callback, pas en ajouter un.
  onSttChange(() => {
    void pushStatus();
    tui.refreshStt(sttState());
  });
  // Budget de contexte atteint : le tchat repart de zéro, dire pourquoi.
  onContextReset((tokens) => tui.contextReset(tokens));

  const showMainSurfaces = () => {
    // L'île reste masquée à idle : sa visibilité est pilotée par les états
    // diffusés (voir broadcastIsland ci-dessous), pas par ce démarrage.
    companion?.showInactive();
    if (!companionCtl && companion) {
      companionCtl = createCompanionController(companion);
      // Mode persisté : redémarrer docké si l'utilisateur l'avait garé.
      if (getConfig().companionMode === "docked") {
        companionCtl.setDocked(true);
      }
    }
  };

  // Dock du compagnon : bascule partagée tray / double-clic sur la fleur,
  // persistée dans la config (survit aux redémarrages).
  const setCompanionDocked = (dockedMode: boolean) => {
    setConfig({ companionMode: dockedMode ? "docked" : "follow" });
    companionCtl?.setDocked(dockedMode);
    // Le panneau expose la même bascule (roam ↔ dock) : la garder synchro
    // quel que soit le point d'entrée (tray, double-clic sur la fleur, panneau).
    sendTo(panel, CH.companionDocked, dockedMode);
  };
  const toggleCompanionDock = () => {
    setCompanionDocked(getConfig().companionMode !== "docked");
  };

  // ---- IPC : enregistré AVANT les fenêtres (les renderers appellent
  // getStatus dès leur chargement) -------------------------------------
  ipcMain.on(CH.micData, (_e, payload: MicDataPayload) => {
    const pcm =
      payload.pcm instanceof Float32Array
        ? payload.pcm
        : new Float32Array(payload.pcm);
    machine?.onMicData(pcm, payload.sampleRate);
  });
  ipcMain.on(CH.micError, (_e, payload: { code: MicErrorCode }) =>
    machine?.onMicError(payload.code),
  );
  ipcMain.on(CH.ttsEnded, () => machine?.onTtsEnded());
  ipcMain.handle(CH.permissionsGet, () => permissionStatuses());
  ipcMain.handle(CH.permissionsRequest, async (_e, id: PermissionId) => {
    await requestPermission(id);
    void pushStatus();
  });
  ipcMain.handle(CH.statusGet, () => buildPanelData());
  ipcMain.handle(CH.configGet, () => getConfig());
  ipcMain.handle(CH.configSet, (_e, patch) => {
    const next = setConfig(patch);
    // Décocher « moods » doit arrêter le sondage tout de suite, pas au
    // prochain changement de visibilité du compagnon.
    syncActivity();
    return next;
  });
  ipcMain.handle(CH.whisperDownload, () => {
    void ensureStt();
  });
  ipcMain.handle(CH.appQuit, () => {
    shutdownEverything();
  });
  // Le panneau mesure sa carte : la fenêtre s'y ajuste pour que les coins
  // arrondis du bas ne soient jamais rognés (voir windows/panel.ts).
  ipcMain.on(CH.panelResize, (_e, height: number) => {
    if (panel && !panel.isDestroyed()) resizePanel(panel, Number(height));
  });
  // ---- Sunflower Work : app dédiée + pilotage des sessions -------------
  ipcMain.handle(CH.workOpen, async () => {
    await openWorkWindow();
    // La fenêtre fraîchement ouverte part d'une liste à jour.
    sendWork(CH.workChanged, workStore.list());
  });
  ipcMain.handle(CH.workList, () => workStore.list());
  ipcMain.handle(CH.workGet, (_e, id: string) => workStore.get(String(id)));
  ipcMain.handle(
    CH.workStart,
    (_e, task: string) => workRunner?.start(String(task)) ?? null,
  );
  ipcMain.handle(CH.workCancel, (_e, id: string) => {
    workRunner?.cancelSession(String(id), "stopped from the work app.");
  });
  ipcMain.handle(CH.workChat, (_e, id: string, text: string) => {
    workRunner?.chat(String(id), String(text));
  });
  ipcMain.handle(CH.workSettingsGet, () => workSettings());
  ipcMain.handle(CH.workSettingsSet, (_e, patch: Partial<WorkSettings>) =>
    workRunner ? workRunner.setSettings(patch) : saveWorkSettings(patch),
  );
  // ---- Sunflower-Code : app dédiée, branchée sur LA session -------------
  // Aucune méthode ne prend d'identifiant de session : il n'y en a qu'une, et
  // c'est celle du terminal. Ce qui est tapé ici ressort là-bas.
  ipcMain.handle(CH.codeOpen, async () => {
    await openCodeWindow();
    // La fenêtre fraîchement ouverte part d'un état à jour.
    codeTranscript.syncInfo();
  });
  ipcMain.handle(CH.codeState, () => codeTranscript.snapshot());
  ipcMain.handle(CH.codeSend, (_e, text: string) => {
    routeToCode(String(text));
  });
  ipcMain.handle(CH.codeApprove, (_e, callId: number, approved: boolean) => {
    codeSession?.approve(Boolean(approved), Number(callId));
  });
  ipcMain.handle(CH.codeInterrupt, () => codeSession?.interrupt());
  ipcMain.handle(CH.codeClear, () => {
    codeSession?.clear();
    codeTranscript.reset();
    codeTranscript.note("conversation cleared.");
  });
  ipcMain.handle(CH.codeSetMode, (_e, mode: CodeMode) => {
    if (!CODE_MODES.includes(mode)) return;
    codeSession?.setMode(mode);
    setConfig({ codeMode: mode });
    // Le terminal et l'app partagent la session : son invite suit le mode
    // choisi ici, exactement comme si /mode avait été tapé.
    tui.setMode(mode);
    codeTranscript.syncInfo();
  });
  ipcMain.handle(CH.codeSetPermission, (_e, permission: CodePermission) => {
    if (!CODE_PERMISSIONS.includes(permission)) return;
    codeSession?.setPermission(permission);
    setConfig({ codePermission: permission });
    codeTranscript.syncInfo();
  });
  ipcMain.handle(CH.codePickWorkdir, async () => {
    const dir = await pickProjectFolder();
    if (!dir) return null;
    return setCodeWorkdir(dir) ? dir : null;
  });
  // ---- Pont Claude Code -------------------------------------------------
  ipcMain.handle(CH.claudeStatus, () => claudeStatus());
  ipcMain.handle(CH.claudeSetEnabled, (_e, on: boolean) =>
    setClaudeEnabled(!!on),
  );
  // Rond : survol (élargir), glisser vertical (repositionner), clic (ouvrir
  // l'app du run affiché). Voir windows/orb.ts.
  ipcMain.on(CH.orbHoverStart, () => orbCtl?.setExpanded(true));
  ipcMain.on(CH.orbHoverEnd, () => orbCtl?.setExpanded(false));
  ipcMain.on(CH.orbDragStart, (_e, y: number) => orbCtl?.dragStart(Number(y)));
  ipcMain.on(CH.orbDragMove, (_e, y: number) => orbCtl?.dragMove(Number(y)));
  ipcMain.on(CH.orbDragEnd, (_e, y: number) => orbCtl?.dragEnd(Number(y)));
  ipcMain.handle(CH.orbOpen, async (_e, source: OrbSource) => {
    if (source === "work") {
      await openWorkWindow();
      sendWork(CH.workChanged, workStore.list());
      return;
    }
    await openCodeWindow();
    codeTranscript.syncInfo();
  });
  // Compagnon : survol de la fleur → fenêtre interactive (double-clic
  // possible) ; hors survol, elle redevient traversée par la souris.
  ipcMain.on(CH.companionHover, (_e, hovering: boolean) => {
    if (companion && !companion.isDestroyed()) {
      companion.setIgnoreMouseEvents(!hovering, { forward: true });
    }
  });
  ipcMain.handle(CH.companionToggleDock, () => {
    toggleCompanionDock();
  });
  ipcMain.handle(CH.onboardingDone, () => {
    setConfig({ onboarded: true });
    if (onboarding && !onboarding.isDestroyed()) {
      onboarding.removeAllListeners("closed");
      onboarding.close();
      onboarding = null;
    }
    showMainSurfaces();
    void ensureStt();
  });

  // ---- Fenêtres --------------------------------------------------------
  island = await createIslandWindow();
  islandVisibility = createIslandVisibility(island);
  // Envoi de l'état à l'île + pilotage de sa visibilité (masquée à idle,
  // affichée dès qu'on en sort, avec délai de grâce au retour — voir
  // windows/island.ts). Point de passage unique utilisé par la machine à
  // états et par l'ambiance des runs de travail en arrière-plan.
  const broadcastIsland = (payload: StatePayload) => {
    sendTo(island, CH.state, payload);
    islandVisibility?.setState(payload.island);
  };
  companion = await createCompanionWindow();
  pointer = await createPointerWindow();
  panel = await createPanelWindow();
  panel.on("show", () => {
    void pushStatus();
    ensureStatusLoop();
  });
  // Rond : masqué au repos, affiché le temps qu'un run Code ou Work tourne
  // (piloté par refreshOrb plus bas).
  orb = await createOrbWindow();
  orbCtl = createOrbController(orb);

  // Exécuteur de guides : purement géométrique, aucun appel IA par étape.
  const guideRunner = createGuideRunner({
    cursor: () => screen.getCursorScreenPoint(),
    showPoint: (target, bounds) => {
      if (!pointer) return;
      const rect = showPointerAt(pointer, target, bounds, { sticky: true });
      tui.debug(
        `guide pointer ${JSON.stringify(target)} → ${rect.x},${rect.y} ${rect.width}×${rect.height}`,
      );
    },
    hidePoint: () => {
      if (pointer) hidePointer(pointer);
    },
    flyTo: (target) => companionCtl?.flyTo(target),
    hold: () => companionCtl?.hold(),
    follow: () => companionCtl?.follow(),
    onMouseDown: onGlobalMouseDown,
    clicksAvailable: mouseHookAvailable,
  });

  // Double vérification du pointage + encadrement DOM : le premier marqueur
  // du modèle n'est qu'une simulation invisible — l'app regarde d'abord quelle
  // application est au premier plan et lit son HTML pour caler le cadre sur
  // l'élément réel ; sinon un second passage vision corrige les coordonnées
  // sur un zoom (voir point-verifier.ts et dom-locator.ts).
  // SUNFLOWER_NO_DOUBLE_CHECK=1 restaure l'affichage direct du premier marqueur.
  const pointVerifier =
    process.env["SUNFLOWER_NO_DOUBLE_CHECK"] === "1"
      ? null
      : createPointVerifier({
          // En mode SUNFLOWER_FAKE_ANSWER (dev sans Ollama), pas de second
          // passage vision — l'encadrement DOM, lui, reste actif.
          chat: process.env["SUNFLOWER_FAKE_ANSWER"]
            ? null
            : (opts) => chat(opts),
          readDom: readFrontmostDom,
          crop: (imageB64, rect) => {
            const img = nativeImage.createFromBuffer(
              Buffer.from(imageB64, "base64"),
            );
            if (img.isEmpty()) return null;
            const cropped = img.crop(rect);
            if (cropped.isEmpty()) return null;
            const size = cropped.getSize();
            return {
              b64: cropped.toJPEG(90).toString("base64"),
              width: size.width,
              height: size.height,
            };
          },
          debug: (line) => tui.debug(line),
        });

  // Dernier état ambiant d'un run de travail : ré-émis quand la session
  // vocale retombe au repos pour que la phase « waiting for you to step
  // away… » (diffusée pendant que la machine est occupée) reste visible.
  let lastWorkAmbient: StatePayload | null = null;
  machine = createSessionMachine({
    broadcast: (payload) => {
      const p =
        payload.island === "idle" && workRunner?.active() && lastWorkAmbient
          ? lastWorkAmbient
          : payload;
      broadcastIsland(p);
      sendTo(companion, CH.state, p);
      tui.state(p);
    },
    micStart: () => sendTo(island, CH.micStart),
    micStop: () => sendTo(island, CH.micStop),
    capture: captureScreenAtCursor,
    transcribe,
    sttReady,
    screenGranted,
    // SUNFLOWER_FAKE_ANSWER (dev) : rejoue un texte comme si le modèle le
    // streamait — test du parseur/guide de bout en bout sans Ollama.
    chat: process.env["SUNFLOWER_FAKE_ANSWER"]
      ? async (opts) => {
          const text = process.env["SUNFLOWER_FAKE_ANSWER"] as string;
          for (const piece of text.match(/.{1,8}/gs) ?? []) {
            opts.onToken(piece);
            await new Promise((r) => setTimeout(r, 25));
          }
          return text;
        }
      : (opts) => chat({ ...opts, onStatus: (s) => tui.chatStatus(s) }),
    answerReset: () => sendTo(companion, CH.answerReset),
    answerToken: (text) => {
      sendTo(companion, CH.answerToken, text);
      tui.answerToken(text);
    },
    answerDone: (full) => {
      sendTo(companion, CH.answerDone, full);
      tui.answerDone();
    },
    ttsStop: () => sendTo(companion, CH.ttsStop),
    onQuestion: (q, source) => tui.question(q, source),
    onSessionError: (ctx, err) => tui.sessionError(ctx, err),
    onPointerDebug: (line) => tui.debug(line),
    showPoint: (point, display) => {
      if (!pointer) return;
      const rect = showPointerAt(pointer, point, display.bounds);
      tui.debug(
        `pointer ${JSON.stringify(point)} → ${rect.x},${rect.y} ${rect.width}×${rect.height}`,
      );
    },
    hidePoint: () => {
      if (pointer) hidePointer(pointer);
    },
    // Sans this : passage direct des méthodes du vérificateur (closure).
    ...(pointVerifier
      ? {
          resolvePoint: pointVerifier.verifyPoint,
          refineGuide: pointVerifier.refineGuide,
        }
      : {}),
    guideStart: (guide, display, cb) => guideRunner.start(guide, display, cb),
    guideCancel: () => guideRunner.cancel(),
    guideStep: (payload) => {
      sendTo(companion, CH.guideStep, payload);
      tui.guideStep(payload.index, payload.total, payload.text);
    },
    // Sunflower Work : opt-in explicite (tray), pilotage remis au runner.
    workEnabled: () => getConfig().sunflowerWorkEnabled,
    workStart: (task) => workRunner?.start(task) != null,
  });

  // L'île/le compagnon ne sont touchés qu'au repos : dès qu'une session
  // vocale démarre, la machine à états reprend la main sur l'affichage.
  const broadcastAmbient = (payload: StatePayload) => {
    broadcastIsland(payload);
    sendTo(companion, CH.state, payload);
  };

  // ---- Le rond du bord droit -------------------------------------------
  // Deux surfaces peuvent travailler sans fenêtre ouverte (Sunflower-Code
  // depuis le terminal, Sunflower Work en tâche de fond) : le rond est leur
  // seul témoin. Rien ne tourne en boucle ici — on recalcule à chaque
  // événement que les deux runners émettent déjà.
  /** null = rien à montrer. `failed` n'en fait pas partie : le `finally` de
   *  la session repasse à `idle` dans la foulée, l'afficher ne ferait qu'un
   *  clignotement avant l'extinction. */
  const codeOrbRun = (info: CodeSessionInfo): OrbRun | null => {
    const turn = `turn ${info.turns}/${info.maxTurns}`;
    const [state, working] =
      info.status === "thinking"
        ? ([`${turn} · thinking…`, true] as const)
        : info.status === "working"
          ? ([`${turn} · running tools…`, true] as const)
          : info.status === "awaiting-approval"
            ? // Une attente d'accord humain n'est pas du travail : le disque
              // reste allumé, mais l'animation s'arrête.
              (["approval waiting for you", false] as const)
            : ([null, false] as const);
    if (state === null) return null;
    return {
      id: "code",
      source: "code",
      title: path.basename(info.workdir) || info.workdir,
      state,
      active: true,
      working,
    };
  };

  const workOrbRun = (s: WorkSessionSummary): OrbRun => {
    const [state, working] =
      s.status === "running"
        ? ([`step ${s.steps}`, true] as const)
        : s.status === "waiting-idle"
          ? (["waiting for you to step away", false] as const)
          : s.status === "paused"
            ? (["paused — you're typing", false] as const)
            : (["queued", false] as const);
    return {
      id: s.id,
      source: "work",
      title: s.task,
      state,
      active: true,
      working,
    };
  };

  /** Dernier état envoyé au rond : les tokens arrivent en rafale sans rien
   *  changer à ce qu'il affiche, inutile de repeindre à chaque mot. */
  let lastOrbKey = "";
  const refreshOrb = (): void => {
    const runs: OrbRun[] = [];
    const info = codeSession?.info();
    const codeRun = info ? codeOrbRun(info) : null;
    if (codeRun) runs.push(codeRun);
    for (const s of workStore.list()) {
      if (WORK_ACTIVE_STATUSES.includes(s.status)) runs.push(workOrbRun(s));
    }
    const key = JSON.stringify(runs);
    if (key === lastOrbKey) return;
    lastOrbKey = key;
    orbCtl?.setStatus(runs);
    if (runs.length > 0) orbCtl?.show();
    else orbCtl?.hide();
  };

  // ---- Sunflower Work : pilotage souris/clavier (opt-in, présence gardée)
  // L'île/le compagnon ne sont touchés qu'au repos — une session vocale
  // reprend toujours la main (et, de toute façon, taper le hotkey est une
  // entrée réelle qui annule le run).
  let workIdleTimer: NodeJS.Timeout | null = null;
  workRunner = createWorkRunner(workStore, {
    settings: workSettings,
    saveSettings: saveWorkSettings,
    onSessionsChanged: (sessions) => {
      sendWork(CH.workChanged, sessions);
      refreshOrb();
    },
    broadcast: (payload) => {
      // Mémorisé même quand la machine est occupée : sa retombée au repos
      // ré-émettra ce dernier état (voir machine.broadcast plus haut).
      lastWorkAmbient = payload;
      if (machine?.busy()) return;
      broadcastAmbient(payload);
    },
    onLog: (line) => tui.log(line),
    onFinished: (result) => {
      lastWorkAmbient = null;
      refreshOrb();
      const note =
        result.status === "done"
          ? `work finished — ${result.message}`
          : result.status === "aborted"
            ? `work stopped — ${result.message}`
            : `work failed — ${result.message}`;
      if (!machine?.busy()) {
        broadcastAmbient({ island: "acting", pose: "idle", message: note });
        if (workIdleTimer) clearTimeout(workIdleTimer);
        workIdleTimer = setTimeout(() => {
          if (!machine?.busy() && !workRunner?.active()) {
            broadcastAmbient({ island: "idle", pose: "idle" });
          }
        }, 4000);
      }
      if (Notification.isSupported()) {
        const short =
          result.task.length > 60 ? `${result.task.slice(0, 57)}…` : result.task;
        new Notification({
          title: "sunflower work",
          body: `"${short}" — ${result.message}`,
        }).show();
      }
    },
  });

  // ---- Humeurs contextuelles du compagnon ------------------------------
  // Purement décoratif : l'app au premier plan (et le site, dans un
  // navigateur) donne un petit accessoire au tournesol. Rien ne sort de la
  // machine, rien n'est écrit, et l'observation s'arrête dès que le compagnon
  // est masqué ou que l'option est décochée. Voir shared/activity.ts.
  activity = createActivityWatcher({
    onChange: (snapshot: ActivitySnapshot) => {
      sendTo(companion, CH.activity, snapshot);
      sendTo(panel, CH.activity, snapshot);
    },
  });
  syncActivity = () => {
    const on =
      getConfig().moodsEnabled &&
      !!companion &&
      !companion.isDestroyed() &&
      companion.isVisible();
    activity?.setEnabled(on);
  };
  companion?.on("show", syncActivity);
  companion?.on("hide", syncActivity);
  syncActivity();

  // ---- Pont vers Claude Code -------------------------------------------
  // La fleur regarde les sessions Claude Code qui tournent dans un terminal à
  // côté, et fait une onde orange quand l'une d'elles a fini. Le signal vient
  // de hooks que Claude lance lui-même : rien ne tourne ici quand Claude ne
  // tourne pas, donc aucune ligne dans scripts/loop-budget.json.
  //
  // Strictement en LECTURE : Sunflower n'envoie jamais rien à Claude. Si ça
  // changeait un jour, un hook Stop qui déclencherait un envoi tournerait en
  // boucle sans fin — à garder en tête avant d'ajouter quoi que ce soit ici.
  claude = createClaudeWatcher({
    isEnabled: () => getConfig().claudeWatchEnabled,
    wantsSound: () => getConfig().claudeChimeEnabled,
    onChanged: (tasks: ClaudeTask[]) => {
      sendTo(panel, CH.claudeChanged, tasks);
    },
    onFinished: (chime) => {
      // Compagnon masqué (accueil en cours) : sendTo ne fait rien, et c'est
      // très bien — une onde que personne ne peut voir n'a pas à être gardée.
      sendTo(companion, CH.claudeFinished, chime);
      tui.debug(`claude finished · ${chime.project}`);
    },
  });
  // `fs.watch` ne survit pas toujours à une veille : le compagnon qui
  // réapparaît est un événement déjà là, donc un rattrapage gratuit.
  companion?.on("show", () => claude?.wake());

  // ---- Sunflower-Code : le harnais de codage ----------------------------
  // Tout ce qui est tapé au CLI hors du mode « ask » part ici (voir
  // routeToCode plus bas), et l'app dédiée tape dans la MÊME session : outils
  // confinés à un dossier, permissions plan/normal/yolo, contexte qui se
  // renouvelle tout seul.
  codeSession = createCodeSession({
    workdir: codeWorkdir,
    mode: getConfig().codeMode,
    permission: getConfig().codePermission,
    onEvent: (ev) => {
      // Le terminal d'abord et sans condition : aucune logique d'app ne peut
      // le priver d'un événement.
      tui.codeEvent(ev);
      codeTranscript.ingest(ev);
      // La jauge de contexte de la barre d'état : même source que celle de
      // l'app, donc les deux disent la même chose.
      const info = codeSession?.info();
      if (info) tui.setUsage(info.tokens, CODE_COMPACT_AT_TOKENS);
      // Le rond suit le harnais même quand aucune fenêtre n'est ouverte.
      refreshOrb();
    },
    capture: async () => {
      const shot = await captureScreenAtCursor();
      return shot ? { imageB64: shot.imageB64 } : null;
    },
  });
  codeTranscript.syncInfo();

  // ---- Arrêt complet ----------------------------------------------------
  // Le bouton « quit » du panneau (et l'entrée du tray) ne se contente pas de
  // fermer les fenêtres : il coupe TOUTE activité — run de travail en cours,
  // session de code, voix, sondage d'humeur — avant de rendre la main.
  // Idempotent : before-quit repasse derrière.
  function shutdownEverything(): void {
    workRunner?.cancel("sunflower is quitting.");
    workRunner?.dispose();
    codeSession?.dispose();
    activity?.dispose();
    // Coupe l'écoute, LAISSE les hooks : l'opt-in survit au redémarrage, et on
    // n'écrit jamais dans les réglages de Claude à la sortie.
    claude?.dispose();
    machine?.interrupt();
    sendTo(companion, CH.ttsStop);
    releaseWorkWindow();
    releaseCodeWindow();
    app.quit();
  }

  // ---- Tray + hotkey ---------------------------------------------------
  createTray({
    onClick: (bounds) => {
      if (panel) togglePanel(panel, bounds);
      ensureStatusLoop();
    },
    onQuit: () => shutdownEverything(),
    isCompanionDocked: () => getConfig().companionMode === "docked",
    onToggleCompanionDock: toggleCompanionDock,
    isWorkEnabled: () => getConfig().sunflowerWorkEnabled,
    onToggleWork: () => {
      workRunner?.setSettings({
        enabled: !getConfig().sunflowerWorkEnabled,
      });
    },
    onOpenWork: () => {
      void openWorkWindow().then(() =>
        sendWork(CH.workChanged, workStore.list()),
      );
    },
    claudeItem: () => {
      const status = claudeStatus();
      // Une case qui ne peut pas marcher le dit AVANT le clic : sans ~/.claude
      // il n'y a rien à installer, et un settings.json illisible ne doit pas
      // être réécrit — dans les deux cas l'entrée est grisée et se renomme.
      if (status.install === "no-claude") {
        return {
          label: "Claude Code not found",
          checked: false,
          enabled: false,
        };
      }
      if (status.install === "unreadable") {
        return {
          label: "Claude hooks — settings.json unreadable",
          checked: false,
          enabled: false,
        };
      }
      return {
        label: "Notify me when Claude finishes",
        checked: status.enabled,
        enabled: true,
      };
    },
    onToggleClaude: () => {
      const result = setClaudeEnabled(!claudeStatus().enabled);
      // Un clic de menu qui ne produit rien de visible est pire qu'une erreur :
      // c'est une action explicite, elle a droit à une ligne au terminal.
      if (!result.ok && result.problem) tui.warn(result.problem);
      else if (result.enabled) tui.ok(`watching Claude — ${result.note ?? ""}`);
      else tui.ok("no longer watching Claude — hooks removed.");
      void pushStatus();
    },
  });
  // Pas de push-to-talk tant que l'accueil n'est pas terminé.
  initHotkey({
    onDown: () => {
      // Le hotkey est une entrée réelle : un run de travail s'efface devant.
      workRunner?.cancel("you pressed the hotkey — all yours.");
      if (!onboarding) {
        // Le modèle se charge pendant que l'utilisateur parle.
        warmModel();
        machine?.hotkeyDown();
      }
    },
    onUp: () => {
      if (!onboarding) machine?.hotkeyUp();
    },
  });

  // ---- Premier lancement ----------------------------------------------
  if (!getConfig().onboarded) {
    onboarding = await createOnboardingWindow();
    onboarding.on("show", () => {
      void pushStatus();
      ensureStatusLoop();
    });
    // Fermer l'accueil sans le terminer = quitter l'app.
    onboarding.on("closed", () => {
      if (!getConfig().onboarded) app.quit();
    });
    ensureStatusLoop();
  } else {
    showMainSurfaces();
    void ensureStt();
    // `sunflower code` : l'app complète, mais la fenêtre du harnais ouverte
    // d'entrée, et l'invite du terminal déjà en mode code — c'est ce qu'on a
    // demandé en tapant la commande. Jamais pendant l'accueil.
    if (process.argv.includes(OPEN_CODE_FLAG)) {
      const wanted = workdirFromArgv(process.argv);
      if (wanted && !setCodeWorkdir(path.resolve(wanted))) {
        tui.warn(`no folder at ${wanted} — staying in ${codeWorkdir}.`);
      }
      tui.setMode(getConfig().codeMode);
      void openCodeWindow().then(() => codeTranscript.syncInfo());
    }
  }

  // ---- Terminal : bannière, préchauffage du modèle, prompt -------------
  const showStatus = () => {
    void buildPanelData().then((data) => tui.status(tuiInfo(data)));
  };

  /**
   * Les commandes du CLI, et leur aide. La table vit ici et pas dans tui.ts :
   * c'est `runCommand` qui les met en œuvre, et une aide qui vit ailleurs que
   * son implémentation est une aide qui ment au premier ajout.
   */
  const SLASH_HELP: readonly (readonly [string, string])[] = [
    ["/help", "this card"],
    ["/mode <ask|code|chat|vision|plan>", "who answers what you type"],
    ["/model [name]", "pick from the installed models, or switch directly"],
    ["/pull <name>", "download a model from ollama"],
    ["/effort [low|medium|high] [20m]", "how much time and effort per task"],
    ["/permission <plan|normal|yolo>", "what sunflower-code may do on its own"],
    ["/cd <folder>", "sunflower-code's project folder"],
    ["/btw <note>", "slip a note into the context, without a reply"],
    ["/image <path>", "attach an image to your next message"],
    ["/init", "write a SUNFLOWER.md describing this project"],
    ["/compact", "renew the context now, keeping a summary"],
    ["/clear", "forget the conversation"],
    ["/code", "open the sunflower-code app"],
    ["/claude [on|off]", "tell me when Claude Code finishes a task"],
    ["/sessions", "saved sunflower work runs"],
    ["/status", "the status card again"],
    ["/work <task>", "hand a computer chore to sunflower work"],
    ["/quit", "close sunflower"],
  ];

  /** Rafraîchit ce que la barre d'état du terminal affiche en permanence. */
  const syncTuiStatus = () => {
    void buildPanelData().then((data) => tui.setStatus(tuiInfo(data)));
  };

  /** `/model` sans argument : la liste des modèles installés, en surimpression. */
  const openModelPicker = async (): Promise<void> => {
    let models;
    try {
      models = await availableModels();
    } catch {
      tui.warn("can't reach ollama — run: ollama serve");
      return;
    }
    if (models.length === 0) {
      tui.warn("no model installed — /pull qwen3-vl:8b downloads the default one.");
      return;
    }
    const active = getConfig().ollamaModel;
    // Sans terminal interactif (sortie redirigée), la surimpression n'a nulle
    // part où vivre : on liste, ce qui reste utile dans un log.
    if (!process.stdout.isTTY) {
      for (const m of models) {
        tui.log(`  ${sameModel(m.name, active) ? "●" : " "} ${m.name}`);
      }
      return;
    }
    const chosen = await tui.pick(
      `select a model (${models.length} installed)`,
      models.map((m) => ({
        value: m.name,
        label: m.name,
        meta: [m.parameterSize, m.quantization, formatBytes(m.sizeBytes)]
          .filter(Boolean)
          .join(" · "),
        current: sameModel(m.name, active),
      })),
    );
    if (chosen === null || sameModel(chosen, active)) return;
    setConfig({ ollamaModel: chosen });
    warmModel();
    syncTuiStatus();
    tui.ok(`model: ${chosen}`);
  };

  /** `/model <nom>` : bascule validée contre ce qui est réellement installé. */
  const switchModel = async (wanted: string): Promise<void> => {
    let installed: string[] = [];
    try {
      installed = (await availableModels()).map((m) => m.name);
    } catch {
      // Ollama muet : on écrit quand même le choix, il vaudra au démarrage
      // suivant. Refuser ici empêcherait de préparer sa config hors ligne.
      setConfig({ ollamaModel: wanted });
      syncTuiStatus();
      tui.warn(`model set to ${wanted}, but ollama is unreachable right now.`);
      return;
    }
    if (!installed.some((name) => sameModel(name, wanted))) {
      tui.warn(`${wanted} isn't installed — /pull ${wanted} downloads it.`);
      return;
    }
    setConfig({ ollamaModel: wanted });
    warmModel();
    syncTuiStatus();
    tui.ok(`model: ${wanted}`);
  };

  /** `/pull <nom>` : téléchargement avec une barre de progression sur place. */
  const pullFromCli = async (model: string): Promise<void> => {
    tui.notice(`pulling ${model} …`);
    let lastShown = 0;
    try {
      await pullModel(ollamaHost(), model, (progress) => {
        // Une ligne toutes les deux secondes : le terminal garde son fil, et
        // une barre qui se redessine n'a pas sa place dans un log à colonnes.
        const now = Date.now();
        if (now - lastShown < 2000) return;
        lastShown = now;
        const pct =
          progress.total > 0
            ? ` ${Math.round((progress.completed / progress.total) * 100)}%`
            : "";
        tui.notice(`${progress.status || "downloading"}${pct}`);
      });
    } catch (err) {
      tui.warn(
        `pull failed — ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return;
    }
    tui.ok(`${model} is ready — /model ${model} makes it active.`);
  };

  /** `/init` : une fiche de projet que le harnais relira au tour suivant. */
  const writeProjectCard = async (): Promise<void> => {
    const dir = codeSession?.info().workdir ?? codeWorkdir;
    const target = path.join(dir, "SUNFLOWER.md");
    if (existsSync(target)) {
      tui.warn(`${target} already exists — nothing written.`);
      return;
    }
    const entries = await readdir(dir).catch(() => [] as string[]);
    const card = [
      `# ${path.basename(dir)}`,
      "",
      "What sunflower-code should know about this project.",
      "",
      "## Layout",
      "",
      ...entries
        .filter((name) => !name.startsWith("."))
        .slice(0, 30)
        .map((name) => `- ${name}`),
      "",
      "## Conventions",
      "",
      "- (describe how this project is meant to be worked on)",
      "",
      "## Commands",
      "",
      "- (build, test, lint…)",
      "",
    ].join("\n");
    try {
      await writeFile(target, card, "utf8");
    } catch (err) {
      tui.warn(
        `couldn't write it — ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return;
    }
    tui.ok(`wrote ${target} — fill it in, sunflower-code reads it.`);
  };

  const runCommand = (name: string, args: string): void => {
    switch (name) {
      case "help":
      case "?":
        tui.help(SLASH_HELP);
        return;
      case "mode": {
        const next = args.trim().toLowerCase() as CliMode;
        if (!CLI_MODES.includes(next)) {
          tui.warn(`modes: ${CLI_MODES.join(", ")} — current: ${tui.mode()}`);
          return;
        }
        tui.setMode(next);
        syncTuiStatus();
        if (next !== "ask") {
          codeSession?.setMode(next);
          setConfig({ codeMode: next as CodeMode });
          codeTranscript.syncInfo();
        }
        return;
      }
      case "permission": {
        const next = args.trim().toLowerCase() as CodePermission;
        if (!CODE_PERMISSIONS.includes(next)) {
          tui.warn(
            `permissions: ${CODE_PERMISSIONS.join(", ")} — current: ${getConfig().codePermission}`,
          );
          return;
        }
        codeSession?.setPermission(next);
        setConfig({ codePermission: next });
        codeTranscript.syncInfo();
        syncTuiStatus();
        tui.ok(`sunflower-code permission: ${next}`);
        return;
      }
      case "cd": {
        const dir = args.trim();
        if (!dir) {
          tui.notice(`project folder: ${codeSession?.info().workdir ?? "?"}`);
          return;
        }
        const abs = path.resolve(dir.replace(/^~(?=$|\/)/, homedir()));
        if (!setCodeWorkdir(abs)) {
          tui.warn(`no folder at ${abs}`);
          return;
        }
        tui.ok(`sunflower-code now works in ${abs}`);
        return;
      }
      case "code":
        void openCodeWindow().then(() => codeTranscript.syncInfo());
        return;
      case "model": {
        const wanted = args.trim();
        void (wanted ? switchModel(wanted) : openModelPicker());
        return;
      }
      case "pull": {
        const wanted = args.trim();
        if (!wanted) {
          tui.warn("usage: /pull <model> — /model lists what's installed.");
          return;
        }
        void pullFromCli(wanted);
        return;
      }
      case "effort": {
        const raw = args.trim();
        if (!raw) {
          tui.notice(
            `effort ${getConfig().effort} · ${formatDeadline(getConfig().effortDeadlineMin)}`,
          );
          return;
        }
        const parsed = parseEffort(raw);
        if (!parsed) {
          tui.warn(
            `effort: ${EFFORTS.join(", ")}, and a time cap like 20m or 2h (off removes it).`,
          );
          return;
        }
        const patch: Partial<SunflowerConfig> = {};
        if (parsed.preset !== undefined) patch.effort = parsed.preset;
        if (parsed.deadlineMin !== undefined) {
          patch.effortDeadlineMin = parsed.deadlineMin;
        }
        setConfig(patch);
        syncTuiStatus();
        tui.ok(
          `effort ${getConfig().effort} · ${formatDeadline(getConfig().effortDeadlineMin)}`,
        );
        return;
      }
      case "btw": {
        const note = args.trim();
        if (!note) {
          tui.warn("usage: /btw <note> — it lands in the context, unanswered.");
          return;
        }
        if (!codeSession) {
          tui.warn("sunflower-code isn't running yet — say something first.");
          return;
        }
        codeSession.note(note);
        tui.ok("noted — sunflower-code will see it on the next message.");
        return;
      }
      case "image": {
        const file = args.trim();
        if (!file) {
          tui.warn("usage: /image <path>");
          return;
        }
        const abs = path.resolve(file.replace(/^~(?=$|\/)/, homedir()));
        void readFile(abs)
          .then((buffer) => {
            codeSession?.attachImage(buffer.toString("base64"));
            tui.ok(`${path.basename(abs)} attached to your next message.`);
          })
          .catch(() => tui.warn(`no readable image at ${abs}`));
        return;
      }
      case "init":
        void writeProjectCard();
        return;
      case "compact":
        if (codeSession?.compact() === true) {
          const n = codeSession.info().terminal;
          codeTranscript.note(`terminal ${n} — the task carries over.`);
          tui.ok(`terminal ${n} — your task and what was done carry over.`);
        } else {
          tui.notice("nothing to compact yet.");
        }
        return;
      case "sessions": {
        const runs = workRunner?.list() ?? [];
        if (runs.length === 0) {
          tui.notice("no saved run — /work <chore> starts one.");
          return;
        }
        for (const run of runs.slice(0, 20)) {
          tui.log(`  ${run.status.padEnd(10)} ${run.task}`);
        }
        return;
      }
      case "claude": {
        const want = args.trim().toLowerCase();
        if (want === "on" || want === "off") {
          const result = setClaudeEnabled(want === "on");
          if (!result.ok) {
            tui.warn(result.problem ?? "couldn't change Claude's hooks.");
            return;
          }
          if (result.enabled) {
            tui.ok("watching Claude Code.");
            if (result.note) tui.notice(result.note);
          } else {
            tui.ok("no longer watching Claude Code — hooks removed.");
          }
          return;
        }
        if (want) {
          tui.warn("usage: /claude [on|off]");
          return;
        }
        const status = claudeStatus();
        // L'écart réglage / installation se montre, il ne se répare pas tout
        // seul : réécrire les réglages de quelqu'un sans qu'il l'ait demandé
        // n'est pas à nous de le décider.
        tui.notice(
          `claude bridge: ${status.enabled ? "on" : "off"} · hooks ${status.install}`,
        );
        if (status.problem) tui.warn(status.problem);
        const tasks = claude?.list() ?? [];
        if (!tasks.length) {
          tui.log("  no Claude session seen yet.");
          return;
        }
        for (const task of tasks.slice(0, 10)) {
          tui.log(`  ${claudeStateLabel(task).padEnd(16)} ${task.project}`);
        }
        return;
      }
      case "status":
        showStatus();
        return;
      case "clear":
        codeSession?.clear();
        codeTranscript.reset();
        codeTranscript.note("conversation cleared.");
        tui.ok("sunflower-code forgot the conversation.");
        return;
      case "work": {
        const task = args.trim();
        if (!task) {
          const running = workRunner?.list().filter((s) =>
            WORK_ACTIVE_STATUSES.includes(s.status),
          );
          tui.notice(
            running && running.length > 0
              ? `${running.length} run(s) in flight — open the work app for the details.`
              : "nothing running. /work <chore> hands one over.",
          );
          return;
        }
        if (!getConfig().sunflowerWorkEnabled) {
          tui.warn(
            "sunflower work is off — enable it in the panel, the tray, or the work app.",
          );
          return;
        }
        const started = workRunner?.start(task);
        if (started) {
          tui.ok(
            getConfig().workRequiredIdleSec > 0
              ? `work queued — "${task}". step away and it starts.`
              : `work queued — "${task}". starting now; it hands the cursor back the moment you use it.`,
          );
        } else {
          tui.warn("work refused it — macOS and the accessibility grant are required.");
        }
        return;
      }
      case "quit":
      case "exit":
        shutdownEverything();
        return;
      default:
        tui.warn(`unknown command /${name} — /help lists them all.`);
    }
  };

  void (async () => {
    const data = await buildPanelData();
    tui.banner(tuiInfo(data));
    if (data.model.reachable && data.model.pulled) warmModel();
    tui.startRepl({
      submit: (q) => (onboarding ? false : (machine?.askText(q) ?? false)),
      code: (message) => {
        if (onboarding) {
          tui.warn("finish the onboarding first.");
          return;
        }
        routeToCode(message);
      },
      approve: (approved, always) =>
        codeSession?.approve(approved, undefined, always),
      command: runCommand,
      interrupt: () => {
        // Ctrl+C au terminal : la session, la session de code ET un éventuel
        // run de travail — tout ce qui pourrait encore tourner.
        workRunner?.cancel("interrupted.");
        codeSession?.interrupt();
        machine?.interrupt();
      },
      quit: () => shutdownEverything(),
      isBusy: () => (machine?.busy() ?? false) || (codeSession?.busy() ?? false),
    });
  })();

  // ---- Cycle de vie ----------------------------------------------------
  app.on("second-instance", (_event, argv) => {
    // `sunflower code` alors que l'app tourne déjà : la seconde instance meurt
    // sur le verrou, mais son argv arrive ici — on ouvre la fenêtre demandée
    // au lieu de basculer le panneau sans rien dire.
    if (argv.includes(OPEN_CODE_FLAG)) {
      const wanted = workdirFromArgv(argv);
      if (wanted) setCodeWorkdir(path.resolve(wanted));
      void openCodeWindow().then(() => codeTranscript.syncInfo());
      return;
    }
    const bounds = trayBounds();
    if (panel && bounds && !panel.isVisible()) togglePanel(panel, bounds);
  });
  app.on("window-all-closed", () => {
    // App accessoire : elle vit dans la barre de menus.
  });

  // ---- La fleur meurt avec son terminal ---------------------------------
  // sunflower est lancée DEPUIS un terminal et lui parle : fermer la fenêtre
  // du terminal doit la fermer aussi, sans quoi il reste une app sans surface
  // de contrôle, qu'on ne retrouve que dans la barre de menus.
  //
  // Deux signaux, tous les deux ÉVÉNEMENTIELS — pas de surveillance
  // périodique du parent, qui serait un coût permanent à déclarer au budget
  // always-on (voir CLAUDE.md) pour apprendre presque toujours la même chose.
  //   - `stdin` se ferme : le terminal a raccroché son bout du tube ;
  //   - `SIGHUP` : le classique « ton terminal est parti ».
  //
  // Armé seulement si on a bien été lancé depuis un terminal : sans TTY,
  // `stdin` est déjà clos et l'app se suiciderait au démarrage.
  if (process.stdin.isTTY === true) {
    const terminalGone = (why: string) => {
      if (quitting) return;
      tui.debug(`terminal gone (${why}) — quitting.`);
      shutdownEverything();
    };
    process.stdin.on("end", () => terminalGone("stdin end"));
    process.stdin.on("close", () => terminalGone("stdin close"));
    process.on("SIGHUP", () => terminalGone("SIGHUP"));
  }
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    tui.dispose();
    machine?.interrupt();
    workRunner?.dispose();
    codeSession?.dispose();
    activity?.dispose();
    claude?.dispose();
    companionCtl?.dispose();
    orbCtl?.dispose();
    islandVisibility?.dispose();
    releaseWorkWindow();
    releaseCodeWindow();
    stopHotkey();
    watchdog.dispose();
    void freeStt();
  });
}
