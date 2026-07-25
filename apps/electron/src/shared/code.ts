/** Sunflower-Code : le harnais de codage agentique, porté depuis Ollama-Code
 *  (github.com/Tromset/Ollama-Code) et branché sur le CLI de sunflower.
 *
 *  Trois briques, exactement comme l'original :
 *   - des MODES (code / chat / vision / plan) qui décident du prompt système
 *     et de la boîte à outils ouverte au modèle,
 *   - sept OUTILS (read_file, write_file, edit_file, move_file, list_files,
 *     search, bash) confinés à un dossier de travail,
 *   - trois NIVEAUX DE PERMISSION (plan / normal / yolo) qui décident de ce
 *     qui part tout seul, de ce qui demande un accord, et de ce qui est
 *     refusé d'office.
 *
 *  Module de types partagé : ni electron, ni node. */

/** Modes de travail — même jeu que Ollama-Code. */
export type CodeMode =
  /** Lecture + écriture + shell : le mode de travail complet. */
  | "code"
  /** Conversation seule : aucun outil n'est exposé au modèle. */
  | "chat"
  /** Comme `code`, plus la capture d'écran jointe au premier tour. */
  | "vision"
  /** Lecture seule : le modèle enquête et rend un plan, sans rien toucher. */
  | "plan";

export const CODE_MODES: readonly CodeMode[] = [
  "code",
  "chat",
  "vision",
  "plan",
] as const;

export const CODE_MODE_HELP: Record<CodeMode, string> = {
  code: "read, write and run — the full workshop",
  chat: "just talk, no tools at all",
  vision: "code, with a screenshot attached to the first turn",
  plan: "read-only: investigate and write a plan, touch nothing",
};

/** Niveaux de permission — du plus prudent au plus lâche. */
export type CodePermission =
  /** Lecture seule. Toute écriture ou commande est refusée d'office. */
  | "plan"
  /** Défaut : lecture libre, écriture et shell soumis à un accord explicite. */
  | "normal"
  /** Tout part sans demander. Réservé aux dossiers jetables. */
  | "yolo";

export const CODE_PERMISSIONS: readonly CodePermission[] = [
  "plan",
  "normal",
  "yolo",
] as const;

export const CODE_PERMISSION_HELP: Record<CodePermission, string> = {
  plan: "read-only — writes and commands are refused outright",
  normal: "reads are free, every write and command asks you first",
  yolo: "no questions asked — only in a folder you can throw away",
};

/** Les sept outils d'Ollama-Code, à l'identique. */
export type CodeToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "move_file"
  | "list_files"
  | "search"
  | "bash";

export const CODE_TOOLS: readonly CodeToolName[] = [
  "read_file",
  "write_file",
  "edit_file",
  "move_file",
  "list_files",
  "search",
  "bash",
] as const;

/** Ce qu'un outil fait au monde extérieur — c'est ce que la permission juge. */
export type CodeToolEffect = "read" | "write" | "execute";

export const CODE_TOOL_EFFECT: Record<CodeToolName, CodeToolEffect> = {
  read_file: "read",
  list_files: "read",
  search: "read",
  write_file: "write",
  edit_file: "write",
  move_file: "write",
  bash: "execute",
};

/** Sort d'un appel d'outil, du point de vue de la permission. */
export type CodeGate =
  /** Part immédiatement. */
  | "allow"
  /** Attend un accord explicite (touche `y` au CLI). */
  | "ask"
  /** Refusé sans appel : le modèle reçoit le refus et continue sans. */
  | "deny";

/** Un appel d'outil demandé par le modèle, et ce qu'il est devenu. */
export interface CodeToolCall {
  /** Index stable dans la session (identifiant de décision). */
  id: number;
  name: CodeToolName;
  /** Arguments déjà validés, tels qu'ils seront exécutés. */
  args: Record<string, string>;
  /** Une ligne lisible : `read_file src/main.ts`, `bash npm test`… */
  display: string;
  status: "pending" | "running" | "done" | "denied" | "refused" | "error";
  /** Résultat rendu au modèle (tronqué pour l'affichage). */
  result?: string;
  /** Motif d'un refus (permission, chemin hors dossier, liste noire…). */
  note?: string;
  /** Durée d'exécution en ms, une fois terminé. */
  ms?: number;
}

/** Un tour de la conversation, tel que le CLI l'affiche. */
export interface CodeMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export type CodeSessionStatus =
  | "idle"
  /** Un tour de modèle est en vol. */
  | "thinking"
  /** Des outils tournent. */
  | "working"
  /** Un appel d'outil attend l'accord de l'utilisateur. */
  | "awaiting-approval"
  | "failed";

/** Événements diffusés par la session (rendus par le TUI). */
export type CodeEvent =
  | { kind: "status"; status: CodeSessionStatus }
  /** Texte du modèle, au fil de l'eau. */
  | { kind: "token"; text: string }
  /** Bloc de réflexion du modèle (<think>…), affichable à part. */
  | { kind: "thinking"; text: string }
  /** Réponse complète du tour. */
  | { kind: "answer"; text: string; turn: number; maxTurns: number }
  /** Un outil va tourner / a tourné (le call porte son propre statut). */
  | { kind: "tool"; call: CodeToolCall }
  /** Sortie brute d'une commande en cours (pseudo-terminal), pas du modèle. */
  | { kind: "output"; text: string }
  /** Un outil attend l'accord : le CLI doit appeler approve(id, ok). */
  | { kind: "approval"; call: CodeToolCall }
  /** Le contexte a été renouvelé (compactage) — combien de tokens. */
  | { kind: "compacted"; tokens: number }
  /** Fin de la requête utilisateur (le prompt peut revenir). */
  | { kind: "done"; text: string }
  | { kind: "error"; message: string };

/** Instantané d'une session, pour `/status` et la doc. */
export interface CodeSessionInfo {
  mode: CodeMode;
  permission: CodePermission;
  workdir: string;
  status: CodeSessionStatus;
  /** Tours de modèle consommés depuis le dernier compactage. */
  turns: number;
  /** Tokens consommés depuis le dernier compactage (mesurés par Ollama). */
  tokens: number;
  /** Messages échangés (système exclu). */
  messages: number;
}
