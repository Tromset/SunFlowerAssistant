// Thème du terminal : rôles, fonte bloc et sous-titre — la moitié « identité »
// de l'habillage, séparée de la trousse ANSI (tui-ansi.ts) qui ne sait que
// peindre et mesurer.
//
// Porté d'Ollama-Code (src/tui/theme.ts), repeint en tournesol : là où
// l'original est rose, on prend le jaune, le clay et la crème déjà utilisés
// par les fenêtres de l'app.

import { PALETTE } from "./tui-ansi";

/**
 * Une conversation se lit à la colonne de gauche, pas à la ponctuation : trois
 * caractères, toujours la même largeur, toujours au même endroit. C'est ce qui
 * fait qu'un flux mêlant questions, réponses, outils et notes se parcourt d'un
 * coup d'œil au lieu de se déchiffrer ligne à ligne.
 */
export const ROLE_WIDTH = 3;

export type LogRole = "you" | "sun" | "sys" | "run" | "err";

export const ROLES: Record<LogRole, { label: string; color: string }> = {
  you: { label: "you", color: PALETTE.yellow },
  sun: { label: "sun", color: PALETTE.cream },
  sys: { label: "sys", color: PALETTE.mute },
  run: { label: "run", color: PALETTE.orange },
  err: { label: "err", color: "#E5484D" },
};

/** Fonte bloc 5 lignes. Seuls les glyphes de « SUNFLOWER » et « CODE » existent. */
const FONT: Record<string, string[]> = {
  S: [" ██████", "██     ", " █████ ", "     ██", "██████ "],
  U: ["██   ██", "██   ██", "██   ██", "██   ██", " █████ "],
  N: ["██   ██", "███  ██", "██ █ ██", "██  ███", "██   ██"],
  F: ["███████", "██     ", "█████  ", "██     ", "██     "],
  L: ["██     ", "██     ", "██     ", "██     ", "███████"],
  O: [" █████ ", "██   ██", "██   ██", "██   ██", " █████ "],
  W: ["██    ██", "██    ██", "██ ██ ██", "███  ███", "██    ██"],
  E: ["███████", "██     ", "█████  ", "██     ", "███████"],
  R: ["██████ ", "██   ██", "██████ ", "██  ██ ", "██   ██"],
  C: [" ██████", "██     ", "██     ", "██     ", " ██████"],
  D: ["██████ ", "██   ██", "██   ██", "██   ██", "██████ "],
  "-": ["     ", "     ", "█████", "     ", "     "],
};

/** Rend un texte dans la fonte bloc. Une chaîne par ligne de la fonte. */
export function blockText(text: string): string[] {
  const glyphs = text
    .toUpperCase()
    .split("")
    .filter((ch) => FONT[ch] !== undefined);
  return [0, 1, 2, 3, 4].map((row) =>
    glyphs.map((ch) => (FONT[ch] as string[])[row]).join(" "),
  );
}

function widthOf(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

/** Marque complète, ~71 colonnes : seuls les terminaux larges la voient. */
export const WORDMARK = blockText("SUNFLOWER");
export const WORDMARK_WIDTH = widthOf(WORDMARK);

/** Repli deux lignes, ~40 colonnes : un terminal de 80 garde le lettrage
 *  bloc au lieu de retomber tout de suite sur du texte plat. */
export const WORDMARK_SPLIT = [...blockText("SUN"), ...blockText("FLOWER")];
export const WORDMARK_SPLIT_WIDTH = widthOf(WORDMARK_SPLIT);

export const SUBTITLE = "L O C A L   A I   ·   T E R M I N A L";
