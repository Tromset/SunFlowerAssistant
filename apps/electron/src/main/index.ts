import {
  BrowserWindow,
  Notification,
  app,
  ipcMain,
  nativeImage,
  screen,
} from "electron";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CH, type MicDataPayload, type MicErrorCode } from "../shared/ipc";
import type { PanelData, PermissionId, StatePayload } from "../shared/state";
import type {
  AgentCommandDecision,
  AgentDecision,
} from "../shared/agents";
import type { ActivitySnapshot } from "../shared/activity";
import {
  CODE_PERMISSIONS,
  type CodeMode,
  type CodePermission,
} from "../shared/code";
import {
  clampWorkSettings,
  type WorkEvent,
  type WorkSettings,
} from "../shared/work";
import { createAgentRunner, type AgentRunner } from "./agents/runner";
import { createActivityWatcher, type ActivityWatcher } from "./activity";
import { createCodeSession, type CodeSession } from "./code/session";
import { createWorkStore } from "./work/store";
import {
  openWorkWindow,
  releaseWorkWindow,
  workWindow,
} from "./windows/work";
import {
  createAgentOrbController,
  createAgentOrbWindow,
  type AgentOrbController,
} from "./windows/agent-orb";
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
import { chat, checkOllama, onContextReset, warmModel } from "./ollama";
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
import { createIslandVisibility, createIslandWindow } from "./windows/island";
import { createOnboardingWindow } from "./windows/onboarding";
import { createPanelWindow, resizePanel, togglePanel } from "./windows/panel";
import {
  createPointerWindow,
  hidePointer,
  showPointerAt,
} from "./windows/pointer";

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
  let agentRunner: AgentRunner | null = null;
  let workRunner: WorkRunner | null = null;
  let orb: BrowserWindow | null = null;
  let orbCtl: AgentOrbController | null = null;
  let activity: ActivityWatcher | null = null;
  let codeSession: CodeSession | null = null;
  let quitting = false;
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

  // Clic sur le rond des agents : ouvrir le panneau et le placer sur l'onglet
  // agents (le renderer du panneau est chargé dès le démarrage, même masqué).
  const openPanelOnAgents = () => {
    const bounds = trayBounds();
    if (panel && bounds && !panel.isVisible()) togglePanel(panel, bounds);
    sendTo(panel, CH.panelFocusAgents);
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
  const workSettings = (): WorkSettings => {
    const cfg = getConfig();
    return {
      enabled: cfg.sunflowerWorkEnabled,
      requiredIdleSec: cfg.workRequiredIdleSec,
      budgetMin: cfg.workBudgetMin,
      maxSteps: cfg.workMaxSteps,
    };
  };
  const saveWorkSettings = (patch: Partial<WorkSettings>): WorkSettings => {
    const next = clampWorkSettings(patch, workSettings());
    setConfig({
      sunflowerWorkEnabled: next.enabled,
      workRequiredIdleSec: next.requiredIdleSec,
      workBudgetMin: next.budgetMin,
      workMaxSteps: next.maxSteps,
    });
    return next;
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
  // Agents de code : toute écriture disque passe par agentDecide (accept),
  // toute exécution de commande par agentCommand (approve) — jamais sans clic.
  ipcMain.handle(CH.agentsList, () => agentRunner?.list() ?? []);
  ipcMain.handle(
    CH.agentStart,
    (_e, task: string, workdir: string, allowCommands: boolean) =>
      agentRunner?.start(String(task), String(workdir), Boolean(allowCommands)),
  );
  ipcMain.handle(CH.agentGet, (_e, id: string) => agentRunner?.get(id) ?? null);
  ipcMain.handle(
    CH.agentDecide,
    (_e, id: string, filePath: string, decision: AgentDecision) =>
      agentRunner?.decide(id, filePath, decision) ?? null,
  );
  ipcMain.handle(
    CH.agentCommand,
    (_e, id: string, commandId: number, decision: AgentCommandDecision) =>
      agentRunner?.decideCommand(
        String(id),
        Number(commandId),
        decision === "approved" ? "approved" : "denied",
      ) ?? null,
  );
  ipcMain.handle(CH.agentCancel, (_e, id: string) => {
    agentRunner?.cancel(id);
  });
  // Rond des agents : survol (élargir), glisser vertical (repositionner),
  // clic (ouvrir le panneau). Voir windows/agent-orb.ts.
  ipcMain.on(CH.agentOrbHoverStart, () => orbCtl?.setExpanded(true));
  ipcMain.on(CH.agentOrbHoverEnd, () => orbCtl?.setExpanded(false));
  ipcMain.on(CH.agentOrbDragStart, (_e, y: number) =>
    orbCtl?.dragStart(Number(y)),
  );
  ipcMain.on(CH.agentOrbDragMove, (_e, y: number) =>
    orbCtl?.dragMove(Number(y)),
  );
  ipcMain.on(CH.agentOrbDragEnd, (_e, y: number) => orbCtl?.dragEnd(Number(y)));
  ipcMain.handle(CH.agentOrbOpen, () => {
    openPanelOnAgents();
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
  // états et par l'ambiance des agents en arrière-plan.
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
  // Rond des agents : masqué au repos, affiché le temps qu'un agent tourne
  // (piloté par agentRunner.onRunningChange plus bas).
  orb = await createAgentOrbWindow();
  orbCtl = createAgentOrbController(orb);

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

  // ---- Agents de code en arrière-plan ----------------------------------
  // L'île/le compagnon ne sont touchés qu'au repos : dès qu'une session
  // vocale démarre, la machine à états reprend la main sur l'affichage.
  let agentIdleTimer: NodeJS.Timeout | null = null;
  let agentNote: string | null = null;
  const broadcastAmbient = (payload: StatePayload) => {
    broadcastIsland(payload);
    sendTo(companion, CH.state, payload);
  };
  agentRunner = createAgentRunner({
    onUpdate: () => {
      const runs = agentRunner?.list() ?? [];
      sendTo(panel, CH.agentsChanged, runs);
      // Même charge utile pour le rond : il en tire le titre + l'état courant.
      orbCtl?.setStatus(runs);
    },
    // Événements fins (tours, tokens, lectures, commandes) : le panneau
    // streame le transcript/terminal, le rond en dérive son texte d'état.
    onEvent: (ev) => {
      sendTo(panel, CH.agentEvent, ev);
      orbCtl?.pushEvent(ev);
    },
    onRunningChange: (running) => {
      // Le rond suit l'état de la file, indépendamment d'une session vocale.
      if (running) orbCtl?.show();
      else orbCtl?.hide();
      if (agentIdleTimer) {
        clearTimeout(agentIdleTimer);
        agentIdleTimer = null;
      }
      if (machine?.busy()) return;
      if (running) {
        broadcastAmbient({
          island: "acting",
          // Vignette « coding » : tournesol + portable animé.
          pose: "coding",
          message: "coding agent at work…",
        });
      } else if (agentNote) {
        // Petit mot de fin sur l'île, puis retour au repos.
        broadcastAmbient({ island: "acting", pose: "idle", message: agentNote });
        agentNote = null;
        agentIdleTimer = setTimeout(() => {
          if (
            !machine?.busy() &&
            !agentRunner?.running() &&
            !workRunner?.active()
          ) {
            broadcastAmbient({ island: "idle", pose: "idle" });
          }
        }, 4000);
      } else if (!workRunner?.active()) {
        // Un run de travail encore actif garde la main sur l'affichage.
        broadcastAmbient({ island: "idle", pose: "idle" });
      }
    },
    onFinished: (run) => {
      const short =
        run.task.length > 60 ? `${run.task.slice(0, 57)}…` : run.task;
      const body =
        run.status === "awaiting-review"
          ? `"${short}" — ${run.proposal.length} file(s) to review in the panel.`
          : run.status === "failed"
            ? `"${short}" — failed: ${run.error ?? "unknown error"}`
            : `"${short}" — finished, nothing to apply.`;
      agentNote =
        run.status === "awaiting-review"
          ? "agent finished — review in the panel"
          : run.status === "failed"
            ? "agent failed — see the panel"
            : "agent finished";
      if (Notification.isSupported()) {
        const notif = new Notification({ title: "sunflower agent", body });
        notif.on("click", () => {
          const bounds = trayBounds();
          if (panel && bounds && !panel.isVisible()) togglePanel(panel, bounds);
        });
        notif.show();
      }
    },
  });

  // ---- Sunflower Work : pilotage souris/clavier (opt-in, présence gardée)
  // Même politesse d'affichage que les agents : l'île/le compagnon ne sont
  // touchés qu'au repos — une session vocale reprend toujours la main (et,
  // de toute façon, taper le hotkey est une entrée réelle qui annule le run).
  let workIdleTimer: NodeJS.Timeout | null = null;
  workRunner = createWorkRunner(workStore, {
    settings: workSettings,
    saveSettings: saveWorkSettings,
    onSessionsChanged: (sessions) => sendWork(CH.workChanged, sessions),
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
          if (
            !machine?.busy() &&
            !agentRunner?.running() &&
            !workRunner?.active()
          ) {
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

  // ---- Sunflower-Code : le harnais de codage du terminal ----------------
  // Tout ce qui est tapé au CLI hors du mode « ask » part ici (voir
  // routeToCode plus bas) : outils confinés à un dossier, permissions
  // plan/normal/yolo, contexte qui se renouvelle tout seul.
  codeSession = createCodeSession({
    workdir: process.cwd(),
    mode: getConfig().codeMode,
    permission: getConfig().codePermission,
    onEvent: (ev) => tui.codeEvent(ev),
    capture: async () => {
      const shot = await captureScreenAtCursor();
      return shot ? { imageB64: shot.imageB64 } : null;
    },
  });

  // ---- Arrêt complet ----------------------------------------------------
  // Le bouton « quit » du panneau (et l'entrée du tray) ne se contente pas de
  // fermer les fenêtres : il coupe TOUTE activité — agents en file, run de
  // travail en cours, session de code, voix, sondage d'humeur — avant de
  // rendre la main. Idempotent : before-quit repasse derrière.
  function shutdownEverything(): void {
    workRunner?.cancel("sunflower is quitting.");
    workRunner?.dispose();
    agentRunner?.dispose();
    codeSession?.dispose();
    activity?.dispose();
    machine?.interrupt();
    sendTo(companion, CH.ttsStop);
    releaseWorkWindow();
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
  }

  // ---- Terminal : bannière, préchauffage du modèle, prompt -------------
  /**
   * LA fonction demandée par le TODO : tout ce que l'utilisateur tape au CLI
   * hors du mode « ask » part à Sunflower-Code. Un seul point de passage, donc
   * un seul endroit à regarder pour savoir où va un message.
   */
  const routeToCode = (message: string): void => {
    if (!codeSession) {
      tui.warn("sunflower-code isn't ready yet.");
      return;
    }
    void codeSession.send(message);
  };

  const showStatus = () => {
    void buildPanelData().then((data) => tui.status(tuiInfo(data)));
  };

  const runCommand = (name: string, args: string): void => {
    switch (name) {
      case "mode": {
        const next = args.trim().toLowerCase() as CliMode;
        if (!CLI_MODES.includes(next)) {
          tui.warn(`modes: ${CLI_MODES.join(", ")} — current: ${tui.mode()}`);
          return;
        }
        tui.setMode(next);
        if (next !== "ask") {
          codeSession?.setMode(next);
          setConfig({ codeMode: next as CodeMode });
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
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          tui.warn(`no folder at ${abs}`);
          return;
        }
        codeSession?.setWorkdir(abs);
        tui.ok(`sunflower-code now works in ${abs}`);
        return;
      }
      case "model": {
        const wanted = args.trim();
        if (!wanted) {
          showStatus();
          return;
        }
        setConfig({ ollamaModel: wanted });
        warmModel();
        tui.ok(`model: ${wanted} — run \`sunflower models\` to browse.`);
        return;
      }
      case "status":
        showStatus();
        return;
      case "clear":
        codeSession?.clear();
        tui.ok("sunflower-code forgot the conversation.");
        return;
      case "work": {
        const task = args.trim();
        if (!task) {
          const running = workRunner?.list().filter((s) =>
            ["queued", "waiting-idle", "running"].includes(s.status),
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
          tui.ok(`work queued — "${task}". step away and it starts.`);
        } else {
          tui.warn("work refused it — macOS and the accessibility grant are required.");
        }
        return;
      }
      case "agents": {
        const runs = agentRunner?.list() ?? [];
        if (runs.length === 0) {
          tui.notice("no background agent — start one from the panel.");
          return;
        }
        for (const run of runs.slice(0, 10)) {
          tui.log(`  ${run.status.padEnd(17)} ${run.task}`);
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
      approve: (approved) => codeSession?.approve(approved),
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
  app.on("second-instance", () => {
    const bounds = trayBounds();
    if (panel && bounds && !panel.isVisible()) togglePanel(panel, bounds);
  });
  app.on("window-all-closed", () => {
    // App accessoire : elle vit dans la barre de menus.
  });
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    tui.dispose();
    machine?.interrupt();
    workRunner?.dispose();
    agentRunner?.dispose();
    codeSession?.dispose();
    activity?.dispose();
    companionCtl?.dispose();
    orbCtl?.dispose();
    islandVisibility?.dispose();
    releaseWorkWindow();
    stopHotkey();
    watchdog.dispose();
    void freeStt();
  });
}
