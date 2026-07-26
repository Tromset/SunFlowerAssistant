// Petite trousse ANSI pour le terminal de sunflower : couleurs de la palette
// de l'app (jaune tournesol, clay, crème), cadres arrondis en dessin de boîte,
// et mesure de largeur qui ignore les séquences d'échappement.
// Zéro dépendance, comme le reste du CLI.

/** Vrai quand le terminal peut afficher des couleurs 24 bits. */
export function supportsTrueColor(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  const ct = (process.env["COLORTERM"] ?? "").toLowerCase();
  if (ct.includes("truecolor") || ct.includes("24bit")) return true;
  const term = (process.env["TERM"] ?? "").toLowerCase();
  // Les terminaux macOS courants (iTerm2, Ghostty, Kitty, WezTerm, Warp,
  // Terminal.app ≥ 26) gèrent tous le 24 bits ; on reste prudent ailleurs.
  return /kitty|wezterm|ghostty|iterm|xterm-256color|screen-256color/.test(term);
}

/** Palette de l'app, transposée au terminal (voir tokens/colors.css). */
export const PALETTE = {
  yellow: "#FCD232",
  yellowDeep: "#E3B91F",
  orange: "#D97757",
  cream: "#FEF9ED",
  green: "#8FD18F",
  mute: "#8A8378",
  brown: "#8B5A2B",
} as const;

export type Paint = (text: string) => string;

export interface Ink {
  /** Couleurs vraies actives ? (sinon tout est rendu tel quel). */
  readonly color: boolean;
  yellow: Paint;
  orange: Paint;
  cream: Paint;
  green: Paint;
  red: Paint;
  dim: Paint;
  bold: Paint;
  /** Fond jaune, texte encre — le badge de mode du prompt. */
  chip: Paint;
  /** Fond clay, texte crème — badge d'alerte. */
  chipWarn: Paint;
  /** Encre d'une couleur arbitraire de la palette (colonne de rôle). */
  hex(color: string): Paint;
}

function hexFg(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
function hexBg(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** Trousse d'encres. `fancy` faux ⇒ toutes les encres sont l'identité. */
export function createInk(fancy: boolean): Ink {
  if (!fancy) {
    const id: Paint = (s) => s;
    return {
      color: false,
      yellow: id,
      orange: id,
      cream: id,
      green: id,
      red: id,
      dim: id,
      bold: id,
      chip: id,
      chipWarn: id,
      hex: () => id,
    };
  }
  const truecolor = supportsTrueColor();
  const fg = (hex: string, fallback: string): Paint =>
    truecolor
      ? (s) => `${hexFg(hex)}${s}\x1b[0m`
      : (s) => `\x1b[${fallback}m${s}\x1b[0m`;
  return {
    color: true,
    yellow: fg(PALETTE.yellow, "33"),
    orange: fg(PALETTE.orange, "31"),
    cream: fg(PALETTE.cream, "37"),
    green: fg(PALETTE.green, "32"),
    red: fg("#E05252", "31"),
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    chip: truecolor
      ? (s) => `${hexBg(PALETTE.yellow)}\x1b[38;2;20;20;19m${s}\x1b[0m`
      : (s) => `\x1b[43;30m${s}\x1b[0m`,
    chipWarn: truecolor
      ? (s) => `${hexBg(PALETTE.orange)}\x1b[38;2;254;249;237m${s}\x1b[0m`
      : (s) => `\x1b[41;37m${s}\x1b[0m`,
    // Sans 24 bits, une couleur libre n'a pas d'équivalent honnête dans les
    // 16 de base : on rend le texte tel quel plutôt que de le peindre faux.
    hex: (color: string): Paint =>
      truecolor ? (s) => `${hexFg(color)}${s}\x1b[0m` : (s) => s,
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Largeur visible d'une chaîne : les séquences ANSI ne comptent pas, les
 *  quelques signes larges qu'on utilise (aucun pour l'instant) non plus. */
export function visibleWidth(text: string): number {
  return [...text.replace(ANSI_RE, "")].length;
}

/** Complète à droite jusqu'à `width` colonnes visibles. */
export function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** Tronque à `width` colonnes visibles (ellipse si ça déborde). */
export function truncVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // Tronquer une chaîne colorée proprement demanderait un parseur complet :
  // on ne tronque que du texte nu, ce qui est le seul cas d'usage ici.
  const plain = text.replace(ANSI_RE, "");
  return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`;
}

export interface BoxOptions {
  /** Titre posé dans le trait du haut. */
  title?: string;
  /** Mention posée à droite dans le trait du haut. */
  badge?: string;
  /** Largeur intérieure (hors bordures et marges). Défaut : le contenu. */
  width?: number;
  ink: Ink;
}

/** Cadre arrondi, du même esprit que les cartes de l'app (border-radius 16px
 *  n'existe pas au terminal : ╭ ╮ ╰ ╯ font le travail). */
export function box(lines: string[], opts: BoxOptions): string[] {
  const { ink } = opts;
  const contentWidth = Math.max(
    opts.width ?? 0,
    visibleWidth(opts.title ?? "") + visibleWidth(opts.badge ?? "") + 6,
    ...lines.map((l) => visibleWidth(l)),
  );
  const inner = contentWidth + 2; // une colonne d'air de chaque côté
  const dash = (n: number) => "─".repeat(Math.max(0, n));
  const title = opts.title ? ` ${opts.title} ` : "";
  const badge = opts.badge ? ` ${opts.badge} ` : "";
  const fill = inner - visibleWidth(title) - visibleWidth(badge) - 2;
  const out: string[] = [];
  out.push(
    [
      ink.dim("╭─"),
      title ? ink.yellow(title) : "",
      ink.dim(dash(fill)),
      badge ? ink.dim(badge) : "",
      ink.dim("─╮"),
    ].join(""),
  );
  for (const line of lines) {
    out.push(
      `${ink.dim("│")} ${padVisible(line, contentWidth)} ${ink.dim("│")}`,
    );
  }
  out.push(ink.dim(`╰${dash(inner)}╯`));
  return out;
}

/**
 * Ne garde que la QUEUE d'un texte en cours d'écriture, mesurée en lignes
 * réellement occupées à l'écran (retour à la ligne automatique compris).
 *
 * Une réponse longue qui grandit sous un bas d'écran fixe finit par pousser
 * le cadre hors du terminal, et le rendu se met à clignoter parce qu'on
 * redessine plus de lignes qu'il n'y en a. Couper la tête plutôt que laisser
 * filer : ce qui compte pendant un flux, c'est la fin.
 */
export function tailLines(
  text: string,
  maxRows: number,
  columns: number,
): { lines: string[]; hidden: number } {
  const width = Math.max(1, columns);
  const raw = text.split("\n");
  const rowsOf = (line: string) =>
    Math.max(1, Math.ceil(visibleWidth(line) / width));
  let rows = 0;
  let start = raw.length;
  while (start > 0) {
    const next = rows + rowsOf(raw[start - 1] ?? "");
    if (next > maxRows && start < raw.length) break;
    rows = next;
    start--;
    if (rows >= maxRows) break;
  }
  return { lines: raw.slice(start), hidden: start };
}

/** Colle deux blocs côte à côte (le dessin à gauche, le texte à droite). */
export function sideBySide(
  left: string[],
  right: string[],
  gap = 3,
): string[] {
  const leftWidth = Math.max(0, ...left.map((l) => visibleWidth(l)));
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    out.push(`${padVisible(l, leftWidth)}${" ".repeat(gap)}${r}`.trimEnd());
  }
  return out;
}
