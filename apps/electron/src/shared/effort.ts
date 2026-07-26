// Effort : combien de temps et de tokens SunFlower a le droit de mettre dans
// une tâche. Avant ce module, chaque surface (compagnon, code, work, agents)
// portait ses propres constantes de budget — quatre fichiers à ouvrir pour
// répondre à « pourquoi il s'arrête si tôt ? ». Elles vivent ici, en trois
// crans, et le cran « medium » reproduit exactement les valeurs historiques :
// changer de preset est un choix explicite, ne rien faire ne change rien.

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Les quatre surfaces qui parlent au modèle, chacune avec son propre profil. */
export type EffortSurface = "companion" | "code" | "work" | "agents";

export interface SurfaceBudget {
  /** Plafond de tokens produits par tour (`num_predict`). */
  numPredict: number;
  /** Fenêtre de contexte demandée à Ollama (`num_ctx`). */
  numCtx: number;
  /** Tours modèle maximum avant abandon (1 = mono-tour). */
  maxTurns: number;
  /** Attente du premier token, modèle déjà chaud. */
  firstTokenMs: number;
}

type EffortTable = Record<Effort, Record<EffortSurface, SurfaceBudget>>;

/**
 * `medium` = l'existant, à la valeur près :
 *   - companion : ollama.ts (700 / 8192 / FIRST_TOKEN_WARM 45 s)
 *   - code      : code/session.ts (2048 / 16384 / MAX_TURNS 24 / 300 s)
 *   - work      : work/runner.ts (220 / 8192 / TURN_TIMEOUT 90 s)
 *   - agents    : agents/runner.ts (2048 / 16384 / MAX_TURNS 8 / 300 s)
 *
 * `low` réduit production et tours (réponses courtes, machine chargée) ;
 * `high` les augmente. Le contexte du compagnon et celui de Work ne bougent
 * jamais : ils sont mono-tour, un num_ctx plus large y coûterait RAM et temps
 * de chargement pour rien. Les attentes de premier token ne bougent pas non
 * plus — c'est le temps que met une machine à charger un modèle, pas un budget.
 */
export const EFFORT_BUDGETS: EffortTable = {
  low: {
    companion: { numPredict: 350, numCtx: 8192, maxTurns: 1, firstTokenMs: 45_000 },
    code: { numPredict: 1024, numCtx: 8192, maxTurns: 12, firstTokenMs: 300_000 },
    work: { numPredict: 160, numCtx: 8192, maxTurns: 1, firstTokenMs: 90_000 },
    agents: { numPredict: 1024, numCtx: 8192, maxTurns: 4, firstTokenMs: 300_000 },
  },
  medium: {
    companion: { numPredict: 700, numCtx: 8192, maxTurns: 1, firstTokenMs: 45_000 },
    code: { numPredict: 2048, numCtx: 16_384, maxTurns: 24, firstTokenMs: 300_000 },
    work: { numPredict: 220, numCtx: 8192, maxTurns: 1, firstTokenMs: 90_000 },
    agents: { numPredict: 2048, numCtx: 16_384, maxTurns: 8, firstTokenMs: 300_000 },
  },
  high: {
    companion: { numPredict: 1400, numCtx: 8192, maxTurns: 1, firstTokenMs: 45_000 },
    code: { numPredict: 4096, numCtx: 32_768, maxTurns: 48, firstTokenMs: 300_000 },
    work: { numPredict: 320, numCtx: 8192, maxTurns: 1, firstTokenMs: 90_000 },
    agents: { numPredict: 4096, numCtx: 32_768, maxTurns: 16, firstTokenMs: 300_000 },
  },
};

export function budgetFor(effort: Effort, surface: EffortSurface): SurfaceBudget {
  return (EFFORT_BUDGETS[effort] ?? EFFORT_BUDGETS.medium)[surface];
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

export interface ParsedEffort {
  /** Preset demandé, si l'argument en nommait un. */
  preset?: Effort;
  /** Plafond de temps par tâche en minutes ; 0 = plus de plafond. */
  deadlineMin?: number;
}

/** Plafond de temps le plus long qu'on accepte d'écrire en config (12 h). */
export const MAX_DEADLINE_MIN = 720;

/**
 * `/effort` accepte deux formes, éventuellement ensemble : un preset
 * (`high`) et une durée (`20m`, `90s`, `2h`, ou un nombre nu lu en minutes).
 * `off` / `0` retire le plafond de temps. Retourne null si rien n'est compris,
 * pour que l'appelant puisse afficher l'aide plutôt qu'un changement muet.
 */
export function parseEffort(args: string): ParsedEffort | null {
  const parsed: ParsedEffort = {};
  for (const token of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (isEffort(token)) {
      parsed.preset = token;
      continue;
    }
    if (token === "off" || token === "none") {
      parsed.deadlineMin = 0;
      continue;
    }
    const duration = /^(\d+(?:\.\d+)?)(h|m|min|s)?$/.exec(token);
    if (!duration) return null;
    const value = Number(duration[1]);
    const unit = duration[2] ?? "m";
    const minutes =
      unit === "h" ? value * 60 : unit === "s" ? value / 60 : value;
    parsed.deadlineMin = Math.min(MAX_DEADLINE_MIN, Math.max(0, Math.round(minutes)));
  }
  return parsed.preset === undefined && parsed.deadlineMin === undefined
    ? null
    : parsed;
}

/** Rend un plafond de temps lisible dans la status bar et les cartes. */
export function formatDeadline(deadlineMin: number): string {
  if (deadlineMin <= 0) return "no time cap";
  if (deadlineMin < 60) return `${deadlineMin}m`;
  const hours = Math.floor(deadlineMin / 60);
  const rest = deadlineMin % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}
