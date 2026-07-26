// Client Ollama direct (100 % local) : /api/tags pour le statut,
// /api/chat en stream NDJSON pour les réponses.
import { getConfig } from "./config-store";
import { budgetFor, type SurfaceBudget } from "../shared/effort";

export class OllamaUserInterrupt extends Error {}
export class OllamaFailure extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

export function ollamaHost(): string {
  let host = process.env["OLLAMA_HOST"] ?? getConfig().ollamaHost;
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host.replace(/\/+$/, "");
}

export interface OllamaStatus {
  host: string;
  /** Modèle réellement utilisé (configuré, sinon premier modèle vision local). */
  name: string;
  reachable: boolean;
  pulled: boolean;
}

interface TagModel {
  name: string;
  capabilities?: string[];
}

function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

/**
 * Le modèle configuré s'il est présent, sinon le premier modèle local avec
 * la capacité vision — l'app doit marcher avec ce qui tourne déjà chez vous.
 */
function pickModel(models: TagModel[]): TagModel | undefined {
  const configured = getConfig().ollamaModel;
  return (
    models.find((m) => sameModel(m.name, configured)) ??
    models.find((m) => (m.capabilities ?? []).includes("vision"))
  );
}

export async function checkOllama(): Promise<OllamaStatus> {
  const host = ollamaHost();
  const name = getConfig().ollamaModel;
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { host, name, reachable: false, pulled: false };
    const data = (await res.json()) as { models?: TagModel[] };
    const picked = pickModel(data.models ?? []);
    return {
      host,
      name: picked?.name ?? name,
      reachable: true,
      pulled: picked !== undefined,
    };
  } catch {
    return { host, name, reachable: false, pulled: false };
  }
}

/** Modèle à utiliser pour une requête (résolu au dernier moment). */
async function resolveModel(): Promise<string> {
  const status = await checkOllama();
  return status.pulled ? status.name : getConfig().ollamaModel;
}

const FIRST_TOKEN_COLD_MS = 180_000; // chargement à froid (disque → RAM/VRAM)
const INTER_TOKEN_MS = 30_000; // silence entre tokens
const KEEP_ALIVE = "10m";
// Contexte, plafond de génération et attente à chaud viennent du preset
// d'effort (shared/effort.ts) : « medium » redonne les valeurs historiques
// (8192 / 700 / 45 s). Le contexte du compagnon ne bouge pas d'un cran à
// l'autre — un num_ctx plus large coûte RAM et chargement pour rien en
// mono-tour ; seul le plafond de réponse suit l'effort.
const budget = (): SurfaceBudget => budgetFor(getConfig().effort, "companion");

/** GET /api/ps — le modèle est-il déjà chargé ? Toute erreur ⇒ froid. */
async function isModelLoaded(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaHost()}/api/ps`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      models?: { name?: string; model?: string }[];
    };
    return (data.models ?? []).some((m) =>
      sameModel(m.name ?? m.model ?? "", model),
    );
  } catch {
    return false;
  }
}

let warming: Promise<void> | null = null;
let warmedAt = 0;

// ---- Budget de contexte ----------------------------------------------
// Chaque question repart de zéro côté messages, mais le runner Ollama, lui,
// survit d'une question à l'autre (keep_alive + cache de préfixe/KV) — et
// avec les petits modèles vision, cet état accumulé finit par dégrader les
// réponses. Au-delà de ce budget de tokens réellement consommés (mesurés par
// Ollama, prompt + réponse), on repart sur un tchat neuf : modèle déchargé
// (tout son état avec) puis préchargé en arrière-plan pendant que
// l'utilisateur lit la réponse.
const CONTEXT_RESET_TOKENS = 10_000;

let sessionTokens = 0;
let resetListener: ((tokens: number) => void) | null = null;

/** Abonné unique (terminal) : prévenu quand un nouveau tchat démarre. */
export function onContextReset(cb: (tokens: number) => void): void {
  resetListener = cb;
}

/** Décharge le runner (keep_alive: 0) puis le précharge : tchat neuf. */
async function resetContext(): Promise<void> {
  const tokens = sessionTokens;
  sessionTokens = 0;
  resetListener?.(tokens);
  try {
    const model = await resolveModel();
    await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model, messages: [], stream: false, keep_alive: 0 }),
    });
  } catch {
    // au pire, le prochain chat rechargera le modèle lui-même
  }
  warmedAt = 0; // sinon warmModel se croit encore chaud et ne fait rien
  warmModel();
}

/** Comptabilise une réponse terminée ; déclenche le reset au-delà du budget.
 *  Les réponses interrompues n'ont pas de compteurs Ollama : non comptées. */
function recordUsage(promptTokens: number, answerTokens: number): void {
  sessionTokens += promptTokens + answerTokens;
  if (sessionTokens >= CONTEXT_RESET_TOKENS) void resetContext();
}

/**
 * Précharge le modèle sans le solliciter (messages vide : pattern officiel
 * Ollama, répond dès que le modèle est en mémoire). Fire-and-forget :
 * dédupliqué, throttlé 30 s, silencieux en cas d'échec. Le num_ctx doit être
 * identique à celui des vraies requêtes, sinon Ollama redémarre le runner à
 * la première question et le préchauffage est perdu.
 */
export function warmModel(): void {
  if (warming || Date.now() - warmedAt < 30_000) return;
  warming = (async () => {
    try {
      const model = await resolveModel();
      const res = await fetch(`${ollamaHost()}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(FIRST_TOKEN_COLD_MS),
        body: JSON.stringify({
          model,
          messages: [],
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { num_ctx: budget().numCtx },
        }),
      });
      if (res.ok) warmedAt = Date.now();
      await res.text().catch(() => "");
    } catch {
      // jamais bloquant, jamais bruyant
    } finally {
      warming = null;
    }
  })();
}

const SYSTEM_PROMPT = [
  "You are sunflower, a calm, unobtrusive screen companion that runs entirely locally on the user's Mac.",
  "The attached image is their current screen; their question was dictated by voice, so it may contain small transcription errors.",
  "Answer in English, in one to three short, warm sentences. No lists, no emoji, no markdown, no code.",
  "If — and only if — pointing at ONE precise element on screen genuinely helps a simple answer, end it with the exact marker [POINT:x1,y1,x2,y2] — the tight bounding box of that element in the image, four integers from 0 to 1000, where 0,0 is the top-left corner of the screen and 1000,1000 the bottom-right (x1,y1 is the element's top-left corner, x2,y2 its bottom-right).",
  "Only point at an element you can actually see at that exact spot in the image. If you are not sure exactly where it is, do not point at all — no marker is always better than a wrong one, and never box the whole screen.",
  'GUIDE MODE: when the user asks HOW TO DO something that takes several mouse actions ("how do I...", "guide me", "where do I click to..."), do not describe the steps in prose.',
  "Instead reply with one short intro sentence, then the full plan: one step per line, in the real order of the actions, at most 6 steps, each step being a marker followed by one short instruction of at most 12 words that will be read aloud.",
  "Use [STEP:x1,y1,x2,y2] instruction — when the target is visible in the image; x1,y1,x2,y2 is its tight bounding box, in the same 0 to 1000 coordinates as [POINT:…]. The guide advances when the user's mouse reaches it.",
  "Use [STEP:x1,y1,x2,y2:click] instruction — when the exact target is not on screen yet (it will appear in a menu, dialog or window); the box is your best estimate of where it will appear. The guide advances when the user clicks.",
  "Use [STEP:click] instruction — when no position can be estimated at all. The guide advances when the user clicks.",
  "After the last step write [DONE] followed by one short closing sentence.",
  "Example: Let's import your video together. [STEP:96,58,164,92] Click the File menu. [STEP:104,142,236,178:click] Click Import in the menu that opens. [STEP:click] Double-click your video in the file dialog. [DONE] That's it, your video is imported.",
  'WORK MODE: when the user asks you to actually DO a computer task FOR them ("archive the newsletters", "close all these tabs", "empty the trash") — an errand to perform, not a question and not how-to guidance — reply with one short sentence saying you\'re getting on it now, then end with the exact marker [WORK: one-line description of the task].',
  "Example: Sure, I'll start archiving those newsletters now. [WORK: archive the newsletter emails in the visible mailbox]",
  "Never combine [WORK:…] with steps or points, and never use it for questions, explanations or code.",
  "Never mention the markers, the step numbers, or any coordinates in your text.",
].join(" ");

/** Supprime en flux les blocs <think>…</think> (défensif).
 *  Exporté : le runner d'agents streame aussi ses tours (voir agents/runner). */
export function createThinkStripper(): (chunk: string) => string {
  let inThink = false;
  let carry = "";
  return (chunk: string): string => {
    let s = carry + chunk;
    carry = "";
    let out = "";
    while (s.length > 0) {
      if (inThink) {
        const end = s.indexOf("</think>");
        if (end === -1) {
          // garde une éventuelle balise fermante coupée
          const tail = s.slice(-8);
          carry = "</think>".startsWith(tail.replace(/^[^<]*/, "")) ? tail : "";
          return out;
        }
        s = s.slice(end + 8);
        inThink = false;
        continue;
      }
      const start = s.indexOf("<think>");
      if (start === -1) {
        // garde une éventuelle balise ouvrante coupée en fin de chunk
        const lt = s.lastIndexOf("<");
        if (lt !== -1 && "<think>".startsWith(s.slice(lt))) {
          out += s.slice(0, lt);
          carry = s.slice(lt);
        } else {
          out += s;
        }
        return out;
      }
      out += s.slice(0, start);
      s = s.slice(start + 7);
      inThink = true;
    }
    return out;
  };
}

/** Statut émis pendant la préparation de la requête. */
export type ChatStatus = "loading-model";

export interface ChatOptions {
  question: string;
  imageB64: string;
  signal: AbortSignal;
  onToken: (text: string) => void;
  /** Avancement notable avant le premier token (ex. chargement à froid). */
  onStatus?: (status: ChatStatus) => void;
  /** Prompt système alternatif (défaut : compagnon d'écran). Utilisé par la
   *  double vérification du pointage (point-verifier). */
  system?: string;
  /** Plafond de génération spécifique (défaut : celui du preset d'effort). */
  numPredict?: number;
}

/** Stream la réponse ; résout avec le texte complet (marqueurs inclus). */
export async function chat(opts: ChatOptions): Promise<string> {
  const model = await resolveModel();
  // À froid, le premier token peut mettre plusieurs minutes (chargement du
  // modèle) : budget large + statut visible au lieu d'un échec à 60 s.
  const warm = await isModelLoaded(model);
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  let watchdog: NodeJS.Timeout | null = null;
  const arm = (ms: number) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
  };
  const strip = createThinkStripper();
  let full = "";
  try {
    if (!warm) opts.onStatus?.("loading-model");
    arm(warm ? budget().firstTokenMs : FIRST_TOKEN_COLD_MS);
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: true,
        think: false,
        keep_alive: KEEP_ALIVE,
        options: {
          temperature: 0.4,
          num_predict: opts.numPredict ?? budget().numPredict,
          num_ctx: budget().numCtx,
        },
        messages: [
          { role: "system", content: opts.system ?? SYSTEM_PROMPT },
          {
            role: "user",
            content: opts.question,
            images: [opts.imageB64],
          },
        ],
      }),
    });
    if (res.status === 404) {
      throw new OllamaFailure(
        `model missing — ollama pull ${model}`,
      );
    }
    if (!res.ok || !res.body) {
      throw new OllamaFailure(`ollama responded ${res.status}.`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(INTER_TOKEN_MS);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: {
          message?: { content?: string };
          done?: boolean;
          error?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.error) throw new OllamaFailure(`ollama : ${parsed.error}`);
        const content = strip(parsed.message?.content ?? "");
        if (content) {
          full += content;
          opts.onToken(content);
        }
        if (parsed.done) {
          recordUsage(parsed.prompt_eval_count ?? 0, parsed.eval_count ?? 0);
          return full;
        }
      }
    }
    return full;
  } catch (err) {
    if (err instanceof OllamaFailure) throw err;
    if (opts.signal.aborted && !timedOut) throw new OllamaUserInterrupt();
    if (timedOut) {
      if (full.length > 0) {
        throw new OllamaFailure("the model stopped mid-answer.");
      }
      throw new OllamaFailure(
        warm
          ? "the model isn't responding."
          : `the model is still loading — warm it with: ollama run ${model}`,
      );
    }
    throw new OllamaFailure("ollama can't be reached — run ollama serve.");
  } finally {
    if (watchdog) clearTimeout(watchdog);
    opts.signal.removeEventListener("abort", onExternalAbort);
  }
}
