// La mémoire de Sunflower-Code, pour l'app dédiée.
//
// La session diffuse des événements ; le terminal les imprime au fil de l'eau
// et n'en garde rien. Une fenêtre, elle, s'ouvre TARD — souvent après qu'une
// conversation entière s'est déroulée dans le terminal — et doit pouvoir
// dessiner tout ce qui précède. `session.history()` ne peut pas servir à ça :
// il rend des CodeMessage (rôle + texte) et perd les appels d'outils, la
// sortie brute des commandes, les compactages et le tour en vol.
//
// Ce module est donc au harnais ce que work/store.ts est au runner de Work :
// le SEUL endroit qui écrit dans la transcription, et il rediffuse chaque
// mutation pour qu'aucune n'échappe à l'app.
//
// Tout est en mémoire. Une conversation de code n'a pas à survivre à la
// fermeture de l'app, et rien de ce qu'elle contient n'a à toucher le disque.
import type {
  CodeAppEvent,
  CodeAppState,
  CodeEntry,
  CodeEvent,
  CodeSessionInfo,
  CodeToolCall,
} from "../../shared/code";

/** Entrées gardées ; au-delà, les plus anciennes sortent. */
const MAX_ENTRIES = 600;
/** Sortie brute gardée par appel de commande. */
const MAX_OUTPUT_CHARS = 20_000;
/** Résultat d'outil gardé pour l'affichage (le modèle a reçu la version
 *  complète — c'est le DOM qu'on protège ici, pas lui). */
const MAX_RESULT_DISPLAY = 4_000;
/** Réponse en vol : garde-fou si un modèle part en boucle. */
const MAX_DRAFT = 200_000;

export interface CodeTranscript {
  /** LE point d'entrée : plie l'événement dans l'historique, puis rediffuse. */
  ingest(ev: CodeEvent): void;
  /** Message tapé par l'utilisateur — la session n'en émet pas d'événement,
   *  et sans ça une question posée au terminal n'existerait pas dans l'app. */
  noteUser(text: string): void;
  /** Marque posée par nous, pas par le modèle : dossier changé, conversation
   *  vidée. Le transcript dit POURQUOI il s'est vidé. */
  note(text: string): void;
  /** Mode, permission ou dossier ont bougé (terminal ou app) : rediffuse. */
  syncInfo(): void;
  snapshot(): CodeAppState;
  /** Repart d'une transcription vierge (/clear, changement de dossier). */
  reset(): void;
}

export function createCodeTranscript(deps: {
  info(): CodeSessionInfo;
  onEvent(ev: CodeAppEvent): void;
}): CodeTranscript {
  let entries: CodeEntry[] = [];
  let draft = "";
  let pending: CodeToolCall | null = null;
  let renewals = 0;
  /** Appel en cours d'exécution : c'est lui qui reçoit la sortie brute. */
  let runningCallId: number | null = null;

  const emit = (ev: CodeAppEvent) => deps.onEvent(ev);

  const push = (entry: CodeEntry) => {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
    }
    emit({ kind: "entry", entry });
  };

  const sendInfo = () => emit({ kind: "info", info: deps.info(), renewals });

  /** La session construit UN objet CodeToolCall et le mute sur place
   *  (pending → running → done), en le réémettant à chaque étape. Sans copie,
   *  chaque entrée déjà affichée se réécrirait toute seule. */
  const snapshotCall = (call: CodeToolCall): CodeToolCall => ({
    ...call,
    ...(call.result !== undefined
      ? { result: call.result.slice(0, MAX_RESULT_DISPLAY) }
      : {}),
  });

  /** Vide la réponse en vol dans une entrée. */
  const flushDraft = (turn: number, maxTurns: number) => {
    const text = draft.trim();
    draft = "";
    if (text) push({ kind: "answer", at: Date.now(), text, turn, maxTurns });
  };

  return {
    ingest(ev) {
      switch (ev.kind) {
        case "status":
          // L'état vit dans info() : une seule source, pas deux à recoller.
          sendInfo();
          return;
        case "token":
          if (draft.length < MAX_DRAFT) draft += ev.text;
          emit({ kind: "token", text: ev.text });
          return;
        case "thinking":
          // Déclaré par le harnais mais jamais émis à ce jour ; l'app n'en
          // fait rien plutôt que d'inventer un affichage pour du vide.
          return;
        case "answer":
          flushDraft(ev.turn, ev.maxTurns);
          return;
        case "tool": {
          const call = snapshotCall(ev.call);
          runningCallId = call.status === "running" ? call.id : null;
          const existing = entries.find(
            (e) => e.kind === "tool" && e.call.id === call.id,
          );
          if (existing && existing.kind === "tool") {
            existing.call = call;
            emit({ kind: "tool", call });
          } else {
            push({ kind: "tool", at: Date.now(), call });
          }
          // L'accord vient d'être tranché — peut-être depuis l'autre surface.
          // C'est ce qui fait disparaître le bandeau de l'app quand on a
          // répondu « y » dans le terminal.
          if (pending && pending.id === call.id) {
            pending = null;
            emit({ kind: "approval", call: null });
          }
          return;
        }
        case "output": {
          const callId = runningCallId ?? 0;
          const last = entries[entries.length - 1];
          if (last?.kind === "output" && last.callId === callId) {
            last.text = (last.text + ev.text).slice(-MAX_OUTPUT_CHARS);
          } else {
            push({
              kind: "output",
              at: Date.now(),
              callId,
              text: ev.text.slice(-MAX_OUTPUT_CHARS),
            });
          }
          emit({ kind: "output", callId, text: ev.text });
          return;
        }
        case "approval":
          pending = snapshotCall(ev.call);
          emit({ kind: "approval", call: pending });
          return;
        case "compacted":
          renewals++;
          push({
            kind: "compacted",
            at: Date.now(),
            tokens: ev.tokens,
            terminal: ev.terminal,
          });
          sendInfo();
          return;
        case "done":
          flushDraft(deps.info().turns, deps.info().maxTurns);
          pending = null;
          emit({ kind: "done" });
          sendInfo();
          return;
        case "error":
          draft = "";
          pending = null;
          push({ kind: "error", at: Date.now(), message: ev.message });
          emit({ kind: "done" });
          sendInfo();
          return;
      }
    },
    noteUser(text) {
      push({ kind: "user", at: Date.now(), text });
    },
    note(text) {
      push({ kind: "note", at: Date.now(), text });
    },
    syncInfo: sendInfo,
    snapshot: () => ({
      info: deps.info(),
      entries: [...entries],
      draft,
      pending,
      renewals,
    }),
    reset() {
      entries = [];
      draft = "";
      pending = null;
      renewals = 0;
      runningCallId = null;
      emit({ kind: "reset" });
      sendInfo();
    },
  };
}
