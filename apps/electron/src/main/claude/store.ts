/** Le registre des sessions Claude vues par la fleur.
 *
 *  Même forme que main/work/store.ts : en mémoire uniquement, seul écrivain,
 *  re-diffuse à chaque mutation, borné. Rien n'est écrit sur disque — ce qu'on
 *  garde ici, ce sont deux lignes de texte tronquées et un statut.
 *
 *  La seule subtilité est le FRONT : « Claude a terminé » n'est pas l'état
 *  `done`, c'est le passage vers `done`. Sans ça, deux tours de suite dans la
 *  même session ne produiraient qu'une onde (le second Stop trouverait la
 *  tâche déjà `done`) — c'est exactement à quoi sert le hook
 *  UserPromptSubmit, qui la ramène à `working` entre les deux. */

import {
  CLAUDE_ACTIVE_STATUSES,
  CLAUDE_MAX_TASKS,
  projectName,
  type ClaudeHookPayload,
  type ClaudeTask,
} from "../../shared/claude";

/** Deux sessions qui finissent coup sur coup ne font qu'une onde. Simple
 *  comparaison d'horodatage : rien n'est armé, donc rien à déclarer au
 *  budget always-on. */
const CHIME_MIN_GAP_MS = 4000;

export interface ClaudeStore {
  list(): ClaudeTask[];
  active(): number;
  apply(payload: ClaudeHookPayload): void;
  clear(): void;
}

export function createClaudeStore(deps: {
  onChanged(tasks: ClaudeTask[]): void;
  /** Appelé UNE fois par front working|waiting → done, coalescence comprise. */
  onFinished(task: ClaudeTask): void;
}): ClaudeStore {
  const tasks = new Map<string, ClaudeTask>();
  let lastChimeAt = 0;

  const list = (): ClaudeTask[] =>
    [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  const changed = (): void => deps.onChanged(list());

  /** Borne la mémoire en jetant les tâches finies les plus anciennes. */
  const trim = (): void => {
    if (tasks.size <= CLAUDE_MAX_TASKS) return;
    const doomed = [...tasks.values()]
      .filter((t) => !CLAUDE_ACTIVE_STATUSES.includes(t.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (tasks.size > CLAUDE_MAX_TASKS && doomed.length) {
      tasks.delete(doomed.shift()!.id);
    }
    // Que des sessions actives : on sacrifie quand même la plus ancienne.
    while (tasks.size > CLAUDE_MAX_TASKS) {
      const oldest = [...tasks.values()].sort(
        (a, b) => a.updatedAt - b.updatedAt,
      )[0];
      if (!oldest) break;
      tasks.delete(oldest.id);
    }
  };

  /** Crée la tâche si besoin : Sunflower a pu être activé en cours de session,
   *  auquel cas le premier événement reçu est un Stop. */
  const upsert = (payload: ClaudeHookPayload): ClaudeTask => {
    const existing = tasks.get(payload.sessionId);
    if (existing) {
      if (payload.cwd && payload.cwd !== existing.cwd) {
        existing.cwd = payload.cwd;
        existing.project = projectName(payload.cwd);
      }
      existing.updatedAt = payload.at;
      return existing;
    }
    const task: ClaudeTask = {
      id: payload.sessionId,
      cwd: payload.cwd,
      project: projectName(payload.cwd),
      status: "idle",
      prompt: "",
      message: "",
      createdAt: payload.at,
      updatedAt: payload.at,
    };
    tasks.set(task.id, task);
    return task;
  };

  return {
    list,
    active: () =>
      [...tasks.values()].filter((t) =>
        CLAUDE_ACTIVE_STATUSES.includes(t.status),
      ).length,

    apply(payload: ClaudeHookPayload): void {
      if (payload.event === "SessionEnd") {
        if (!tasks.delete(payload.sessionId)) return;
        changed();
        return;
      }

      const task = upsert(payload);
      switch (payload.event) {
        case "SessionStart":
          // Une reprise (`resume`) retombe sur une session ouverte, pas finie.
          if (task.status === "done") task.status = "idle";
          break;
        case "UserPromptSubmit":
          task.status = "working";
          task.prompt = payload.prompt;
          task.message = "";
          task.finishedAt = undefined;
          break;
        case "Notification":
          if (task.status !== "done") task.status = "waiting";
          break;
        case "Stop": {
          const wasRunning = CLAUDE_ACTIVE_STATUSES.includes(task.status);
          task.status = "done";
          task.message = payload.message;
          task.finishedAt = payload.at;
          // Le Stop d'une session dont on n'a jamais vu la question compte
          // aussi : c'est le cas quand on vient d'activer le pont.
          const first = !wasRunning && task.createdAt === payload.at;
          if (wasRunning || first) {
            const now = Date.now();
            if (now - lastChimeAt >= CHIME_MIN_GAP_MS) {
              lastChimeAt = now;
              deps.onFinished(task);
            }
          }
          break;
        }
      }
      trim();
      changed();
    },

    clear(): void {
      if (!tasks.size) return;
      tasks.clear();
      changed();
    },
  };
}
