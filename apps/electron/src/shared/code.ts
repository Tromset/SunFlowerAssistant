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
import type { DiffLine } from "./diff";

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

// ---- Les portes : ce que le niveau laisse passer --------------------------
// Portées telles quelles depuis Ollama-Code. Vivaient dans
// main/code/permissions.ts, mais elles n'importent que ce module : elles
// descendent en partagé pour que l'app puisse afficher la VRAIE porte de
// chaque outil au lieu de paraphraser la doc.
//
//   plan    lecture seule       write/execute refusés d'office
//   normal  lecture libre       write/execute demandent un accord (défaut)
//   yolo    tout part           rien ne demande rien
//
// Le MODE peut restreindre davantage mais jamais élargir : `plan` et `chat`
// n'exposent au modèle que les outils qui n'écrivent rien, quel que soit le
// niveau — un `yolo` en mode plan reste en lecture seule.

/** Sort d'un outil sous un niveau donné. */
export function gateFor(
  permission: CodePermission,
  tool: CodeToolName,
): CodeGate {
  const effect = CODE_TOOL_EFFECT[tool];
  if (effect === "read") return "allow";
  switch (permission) {
    case "plan":
      return "deny";
    case "yolo":
      return "allow";
    case "normal":
      return "ask";
  }
}

/** Phrase montrée à l'utilisateur quand un outil est refusé d'office. */
export function denyReason(
  permission: CodePermission,
  tool: CodeToolName,
): string {
  return `${tool} is a ${CODE_TOOL_EFFECT[tool]} tool and the permission level is "${permission}" — switch with /permission normal.`;
}

/** Outils réellement exposés au modèle pour un mode + un niveau donnés. */
export function toolsFor(
  mode: CodeMode,
  permission: CodePermission,
): CodeToolName[] {
  if (mode === "chat") return [];
  const readOnly = mode === "plan" || permission === "plan";
  return CODE_TOOLS.filter(
    (t) => !readOnly || CODE_TOOL_EFFECT[t] === "read",
  );
}

// ---- Bornes du harnais ----------------------------------------------------
// Exportées pour que les jauges de l'app aient le MÊME dénominateur que la
// session : une constante recopiée dans un renderer dérive au premier réglage.

/** Tours de modèle pour une seule requête utilisateur. */
export const CODE_MAX_TURNS = 24;
/** Au-delà, la session se compacte et repart d'une fenêtre neuve. */
export const CODE_COMPACT_AT_TOKENS = 12_000;

/** Un fichier écrit ou modifié par un appel d'outil, et ce qui a changé.
 *  Seul le diff traverse l'IPC — jamais le contenu des fichiers. */
export interface CodeFileChange {
  /** Chemin relatif au dossier de projet. */
  path: string;
  added: number;
  removed: number;
  /** Déjà borné et élidé par shared/diff.ts. */
  diff: DiffLine[];
}

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
  /** Ce que l'appel a écrit sur le disque (write_file / edit_file). */
  changes?: CodeFileChange[];
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
  /** Un outil attend l'accord : le terminal répond avec approve(ok), l'app
   *  avec approve(ok, call.id) — deux surfaces, un seul accord en vol. */
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

// ---- L'app dédiée ---------------------------------------------------------
// La session diffuse des événements ; le terminal les imprime au fil de l'eau
// et n'en garde rien. Une fenêtre, elle, s'ouvre TARD — souvent après qu'une
// conversation entière s'est déroulée dans le terminal — et doit pouvoir
// dessiner tout ce qui précède. D'où une transcription : ce que
// `session.history()` ne peut pas rendre (il perd les appels d'outils, la
// sortie brute des commandes, les compactages et le tour en vol).

/** Une entrée de la transcription, dans l'ordre où elle est arrivée. */
export type CodeEntry =
  | { kind: "user"; at: number; text: string }
  | {
      kind: "answer";
      at: number;
      text: string;
      turn: number;
      maxTurns: number;
    }
  | { kind: "tool"; at: number; call: CodeToolCall }
  /** Sortie brute d'une commande, rattachée à l'appel qui l'a produite. */
  | { kind: "output"; at: number; callId: number; text: string }
  | { kind: "compacted"; at: number; tokens: number }
  | { kind: "error"; at: number; message: string }
  /** Marque posée par nous, pas par le modèle : dossier changé, conversation
   *  vidée. Le transcript dit POURQUOI il s'est vidé. */
  | { kind: "note"; at: number; text: string };

/** Instantané rendu à l'ouverture de la fenêtre. */
export interface CodeAppState {
  info: CodeSessionInfo;
  entries: CodeEntry[];
  /** Réponse en vol, token par token : une fenêtre ouverte EN PLEIN STREAM
   *  rattrape le fil au lieu de commencer au milieu d'une phrase. */
  draft: string;
  /** Accord en attente, ou null. */
  pending: CodeToolCall | null;
  /** Compactages depuis le début de la conversation. */
  renewals: number;
}

/** Événements diffusés à l'app. Un événement ne redessine que ce qu'il
 *  touche — c'est la règle du renderer de Work, reprise telle quelle. */
export type CodeAppEvent =
  | { kind: "entry"; entry: CodeEntry }
  | { kind: "token"; text: string }
  /** Un appel déjà affiché change d'état (running → done / error). */
  | { kind: "tool"; call: CodeToolCall }
  /** Delta de sortie brute : s'ajoute au bloc de l'appel, pas une entrée neuve. */
  | { kind: "output"; callId: number; text: string }
  /** null : l'accord vient d'être tranché — éventuellement par le terminal. */
  | { kind: "approval"; call: CodeToolCall | null }
  | { kind: "info"; info: CodeSessionInfo; renewals: number }
  /** La transcription est repartie de zéro (/clear, changement de dossier). */
  | { kind: "reset" }
  | { kind: "done" };
