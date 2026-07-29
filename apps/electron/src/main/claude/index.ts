/** Le pont vers Claude Code, vu de l'extérieur : un interrupteur, une liste,
 *  et une onde quand Claude a fini.
 *
 *  Assemble les trois pièces — l'installation des hooks (hooks.ts), la source
 *  d'événements (spool.ts) et le registre (store.ts) — et n'expose au reste de
 *  l'app que ce dont index.ts a besoin.
 *
 *  Coût quand personne ne touche à rien : zéro. Aucun `setInterval`, aucun
 *  `setTimeout` qui se replanifie, aucun processus lancé par Sunflower. Le
 *  seul processus de la chaîne est notre script shell, lancé par Claude Code
 *  dans SON arbre, et seulement quand Claude tourne. */

import { powerMonitor } from "electron";
import {
  CLAUDE_MAX_TEXT,
  CLAUDE_NEXT_SESSION_NOTE,
  truncate,
  type ClaudeChime,
  type ClaudeStatus,
  type ClaudeTask,
  type ClaudeToggleResult,
} from "../../shared/claude";
import {
  claudePaths,
  hookInstallState,
  installHooks,
  uninstallHooks,
} from "./hooks";
import { createClaudeSpool } from "./spool";
import { createClaudeStore } from "./store";

export interface ClaudeWatcher {
  /** Active ou coupe le pont. Rend ce qu'il faut afficher à l'utilisateur.
   *  SEUL point du module qui écrit dans ~/.claude/settings.json, et il n'est
   *  appelé que depuis un geste explicite (case du tray, /claude on|off). */
  setEnabled(on: boolean): ClaudeToggleResult;
  status(): ClaudeStatus;
  list(): ClaudeTask[];
  /** Relance une lecture du spool depuis un événement gratuit. */
  wake(): void;
  dispose(): void;
}

export function createClaudeWatcher(deps: {
  /** Le réglage persistant : lu, jamais écrit ici (voir index.ts). */
  isEnabled(): boolean;
  /** `claudeChimeEnabled` : coupe le son sans couper l'onde. */
  wantsSound(): boolean;
  onChanged(tasks: ClaudeTask[]): void;
  onFinished(chime: ClaudeChime): void;
}): ClaudeWatcher {
  const paths = claudePaths();
  let enabled = false;

  const store = createClaudeStore({
    onChanged: deps.onChanged,
    onFinished: (task) => {
      deps.onFinished({
        project: task.project,
        message:
          truncate(task.message, CLAUDE_MAX_TEXT) || "finished its turn.",
        sound: deps.wantsSound(),
      });
    },
  });

  const spool = createClaudeSpool({
    dir: paths.spool,
    onPayload: (payload) => store.apply(payload),
  });

  const wake = (): void => {
    if (enabled) spool.wake();
  };

  // `fs.watch` ne survit pas toujours à une veille : deux événements déjà
  // gratuits suffisent à le remettre en route, sans la moindre minuterie.
  powerMonitor.on("resume", wake);
  powerMonitor.on("unlock-screen", wake);

  const start = (): void => {
    if (enabled) return;
    enabled = true;
    spool.arm();
  };

  const stop = (): void => {
    if (!enabled) return;
    enabled = false;
    spool.disarm();
    store.clear();
  };

  // Le réglage survit au redémarrage : si le pont était actif, on reprend.
  if (deps.isEnabled()) start();

  return {
    setEnabled(on: boolean): ClaudeToggleResult {
      if (on) {
        const result = installHooks();
        if (!result.ok) {
          stop();
          return {
            ok: false,
            enabled: false,
            install: result.state,
            ...(result.problem ? { problem: result.problem } : {}),
          };
        }
        start();
        return {
          ok: true,
          enabled: true,
          install: result.state,
          note: CLAUDE_NEXT_SESSION_NOTE,
        };
      }
      stop();
      const result = uninstallHooks();
      return {
        ok: result.ok,
        enabled: false,
        install: result.state,
        ...(result.problem ? { problem: result.problem } : {}),
      };
    },

    status(): ClaudeStatus {
      const install = hookInstallState();
      return {
        enabled: deps.isEnabled(),
        install: install.state,
        active: store.active(),
        ...(install.problem ? { problem: install.problem } : {}),
      };
    },

    list: () => store.list(),
    wake,

    dispose(): void {
      // On coupe l'écoute mais on LAISSE les hooks en place : l'opt-in survit
      // au redémarrage, et un hook qui écrit dans un spool borné que personne
      // ne lit ne coûte rien à personne.
      powerMonitor.off("resume", wake);
      powerMonitor.off("unlock-screen", wake);
      spool.disarm();
      enabled = false;
    },
  };
}
