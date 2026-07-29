/** Le pont vers Claude Code : ce que la fleur sait des sessions qui tournent
 *  dans un terminal à côté, et de leur fin.
 *
 *  Sunflower OBSERVE, il ne pilote rien. Le bon modèle mental est
 *  main/activity.ts — un capteur — et surtout pas work/runner.ts : il n'y a ni
 *  file d'attente, ni annulation, ni étapes, et N sessions peuvent vivre en
 *  même temps. C'est aussi la réponse à « pourquoi pas WorkStore ? » : une
 *  WorkSession modélise ce que Sunflower CONDUIT (une souris, donc une file),
 *  et la moitié de ses champs n'aurait aucun sens ici.
 *
 *  Le signal vient des hooks de Claude Code : Claude lance notre petit script,
 *  le script pose un fichier, FSEvents réveille l'app. Rien ne tourne quand
 *  Claude ne tourne pas — c'est ce que réclame le budget always-on de
 *  CLAUDE.md, et c'est pourquoi on ne relit pas les transcripts .jsonl.
 *
 *  Module de types partagé main ↔ renderer : ni electron, ni node. */

/** Où en est une session Claude, vu de l'extérieur. */
export type ClaudeTaskStatus =
  /** Ouverte, rien demandé pour l'instant (SessionStart). */
  | "idle"
  /** Une question est partie, Claude répond (UserPromptSubmit). */
  | "working"
  /** Claude attend un accord ou une réponse humaine (Notification). */
  | "waiting"
  /** Claude a fini son tour (Stop) — c'est ce qui déclenche l'onde. */
  | "done";

/** Les statuts qui comptent comme « quelque chose est en cours ». */
export const CLAUDE_ACTIVE_STATUSES: readonly ClaudeTaskStatus[] = [
  "working",
  "waiting",
] as const;

/** Une session Claude Code suivie par la fleur. */
export interface ClaudeTask {
  /** `session_id` du hook : stable pour toute la durée de la session. */
  id: string;
  /** Dossier du projet, tel que Claude le rapporte. */
  cwd: string;
  /** Nom lisible tiré de `cwd` (voir projectName). */
  project: string;
  status: ClaudeTaskStatus;
  /** Dernière question posée, tronquée. Vide tant qu'il n'y en a pas eu. */
  prompt: string;
  /** Dernier message de Claude, tronqué. Rempli par Stop. */
  message: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

/** Ce que le compagnon reçoit quand Claude a terminé : de quoi écrire une
 *  ligne, et le seul réglage dont le renderer a besoin. */
export interface ClaudeChime {
  project: string;
  message: string;
  /** `claudeChimeEnabled` : le son se coupe sans couper l'onde. */
  sound: boolean;
}

/** État d'installation du bloc de hooks dans ~/.claude/settings.json. */
export type ClaudeInstallState =
  /** Pas de ~/.claude : Claude Code n'est pas installé sur cette machine. */
  | "no-claude"
  /** Aucun de nos hooks n'est là. */
  | "absent"
  /** Tous nos hooks sont là. */
  | "installed"
  /** Certains seulement — le fichier a été édité à la main entre-temps. */
  | "partial"
  /** Nos entrées sont là mais le script a disparu (dossier de données
   *  effacé). Elles ne font rien : le script est gardé par un `[ -x ]`. */
  | "stale"
  /** `disableAllHooks: true` : Claude n'exécutera aucun hook, dont les nôtres. */
  | "disabled"
  /** Fichier illisible (JSON invalide, droits) : on n'y touche pas. */
  | "unreadable";

/** Ce que l'app affiche du pont : installé ou non, et ce qui tourne. */
export interface ClaudeStatus {
  /** Le réglage `claudeWatchEnabled`. */
  enabled: boolean;
  install: ClaudeInstallState;
  /** Nombre de sessions actives (voir CLAUDE_ACTIVE_STATUSES). */
  active: number;
  /** Message déjà rédigé quand quelque chose cloche. */
  problem?: string;
}

/** Retour d'un basculement de l'interrupteur : l'appelant l'affiche tel quel,
 *  parce qu'une case cochée qui ne produit rien de visible est pire qu'une
 *  erreur. */
export interface ClaudeToggleResult {
  ok: boolean;
  enabled: boolean;
  install: ClaudeInstallState;
  problem?: string;
  /** Précision utile mais pas alarmante — typiquement le fait que Claude Code
   *  lit ses hooks au démarrage d'une session. */
  note?: string;
}

/** Claude Code charge ses hooks à l'ouverture d'une session : une session déjà
 *  ouverte ne verra jamais ceux qu'on vient d'installer. Sans le dire, la
 *  fonctionnalité passe pour cassée. */
export const CLAUDE_NEXT_SESSION_NOTE =
  "Claude reads its hooks when a session starts — open a new one.";

/** Les événements de Claude Code auxquels on s'abonne.
 *
 *  Chaque hook `command` est un vrai processus lancé dans l'arbre de Claude :
 *  la liste est courte exprès. `SubagentStop` en est ABSENT volontairement —
 *  un seul tour peut lancer une dizaine de sous-agents, ce qui ferait autant
 *  de processus et une rafale d'ondes. Ne pas l'ajouter « pour compléter ».
 *
 *  Coût en régime établi : deux `/bin/sh` par tour (UserPromptSubmit + Stop). */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/** Le filtre `matcher` de chaque événement, ou "" quand il n'en accepte pas.
 *
 *  Pour Notification on ne veut QUE les cas où Claude est bloqué sur l'humain ;
 *  les autres (auth_success, elicitation_*) ne changent rien à l'état d'une
 *  tâche et ne méritent pas un processus. */
export const CLAUDE_HOOK_MATCHERS: Record<ClaudeHookEvent, string> = {
  // `compact` est exclu exprès : il se déclenche en boucle pendant une longue
  // tâche, et ne dit rien qu'on ne sache déjà.
  SessionStart: "startup|resume|clear",
  UserPromptSubmit: "",
  // `idle_prompt` est exclu : il arrive APRÈS un Stop qu'on a déjà traité,
  // donc c'est un processus pour un signal en double.
  Notification: "permission_prompt|agent_needs_input",
  Stop: "",
  SessionEnd: "",
};

/** Charge utile d'un hook, réduite à ce dont on se sert. */
export interface ClaudeHookPayload {
  event: ClaudeHookEvent;
  sessionId: string;
  cwd: string;
  /** UserPromptSubmit. */
  prompt: string;
  /** Stop : `last_assistant_message`. */
  message: string;
  /** Horodatage posé par le lecteur, pas par Claude (voir spool.ts). */
  at: number;
}

/** Plafond de troncature des textes gardés en mémoire.
 *
 *  Ni le prompt ni la réponse de Claude n'ont à vivre entiers dans Sunflower :
 *  on n'affiche qu'une ligne, et le fichier du spool est supprimé sitôt lu. */
export const CLAUDE_MAX_TEXT = 160;

/** Combien de sessions on garde en mémoire (rien n'est écrit sur disque). */
export const CLAUDE_MAX_TASKS = 20;

/** Coupe proprement, sans couper un mot en deux quand c'est évitable. */
export function truncate(text: string, max = CLAUDE_MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** Nom lisible d'un projet à partir de son dossier. */
export function projectName(cwd: string): string {
  const clean = cwd.replace(/\/+$/, "");
  if (!clean) return "/";
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  return base || clean;
}

const isEvent = (v: unknown): v is ClaudeHookEvent =>
  typeof v === "string" &&
  (CLAUDE_HOOK_EVENTS as readonly string[]).includes(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Lit un fichier du spool. Rend null sur tout ce qui n'est pas exploitable —
 *  un fichier tronqué ou d'une version future ne doit rien casser. */
export function parseHookPayload(raw: string, at: number): ClaudeHookPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (!isEvent(o.hook_event_name)) return null;
  const sessionId = str(o.session_id);
  if (!sessionId) return null;
  return {
    event: o.hook_event_name,
    sessionId,
    cwd: str(o.cwd),
    prompt: truncate(str(o.prompt)),
    message: truncate(str(o.last_assistant_message)),
    at,
  };
}

/** Le mot d'état affiché dans le panneau — déjà rédigé côté partagé pour que
 *  le renderer n'ait pas à connaître le modèle. */
export function claudeStateLabel(task: ClaudeTask): string {
  switch (task.status) {
    case "working":
      return "working…";
    case "waiting":
      return "waiting for you";
    case "done":
      return "done";
    default:
      return "open";
  }
}
