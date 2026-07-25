// Rendu pixel-art dans un terminal. Le même dessin que les fenêtres de l'app
// (shared/sunflower-pixels.ts) s'affiche au CLI, en vrai, sans art ASCII
// approximatif : chaque caractère « ▀ » porte DEUX pixels — la moitié haute en
// couleur d'avant-plan, la moitié basse en couleur de fond — et chaque pixel
// est doublé horizontalement pour compenser les cellules de terminal, qui font
// à peu près deux fois plus haut que large. Résultat : des pixels carrés.
//
// Zéro dépendance, comme le reste du terminal de sunflower. Sans couleurs
// vraies (NO_COLOR, terminal pauvre), l'appelant retombe sur la bannière
// texte — voir tui-ansi.ts.
import type { PixelArt } from "../shared/sunflower-pixels";

/** Demi-bloc haut : l'avant-plan peint la moitié supérieure de la cellule. */
const HALF = "▀";

type Rgb = [number, number, number];

/** « #FCD232 » → [252, 210, 50]. Toute couleur illisible devient noire. */
function rgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Grille de couleurs (null = transparent), calques peints dans l'ordre. */
function rasterize(art: PixelArt): (string | null)[][] {
  const [w, h] = art.vb;
  const grid: (string | null)[][] = Array.from({ length: h }, () =>
    new Array<string | null>(w).fill(null),
  );
  for (const layer of art.layers) {
    // Les rotations SVG n'ont pas de sens sur une grille de caractères : le
    // calque est peint droit. Les scènes penchées restent lisibles.
    for (const r of layer.rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (y < 0 || y >= h || x < 0 || x >= w) continue;
          const row = grid[y];
          if (row) row[x] = r.c;
        }
      }
    }
  }
  return grid;
}

export interface PixelRenderOptions {
  /** Cellules de terminal par pixel d'art, horizontalement (défaut 2). */
  scaleX?: number;
  /** Couleurs vraies disponibles ? Faux ⇒ rendu monochrome en blocs. */
  color?: boolean;
}

/**
 * Rend un PixelArt en lignes de terminal. Chaque ligne rendue couvre deux
 * rangées de pixels ; la hauteur du résultat est donc ceil(vb.h / 2).
 */
export function pixelArtLines(
  art: PixelArt,
  options: PixelRenderOptions = {},
): string[] {
  const scaleX = Math.max(1, Math.round(options.scaleX ?? 2));
  const color = options.color !== false;
  const grid = rasterize(art);
  const [w, h] = art.vb;
  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    let openTop: string | null = null;
    let openBottom: string | null = null;
    const reset = () => {
      if (openTop !== null || openBottom !== null) {
        line += "\x1b[0m";
        openTop = null;
        openBottom = null;
      }
    };
    for (let x = 0; x < w; x++) {
      const top = grid[y]?.[x] ?? null;
      const bottom = grid[y + 1]?.[x] ?? null;
      if (top === null && bottom === null) {
        reset();
        line += " ".repeat(scaleX);
        continue;
      }
      if (!color) {
        // Monochrome : la forme survit, la couleur non.
        reset();
        line += (top !== null && bottom !== null
          ? "█"
          : top !== null
            ? HALF
            : "▄"
        ).repeat(scaleX);
        continue;
      }
      if (top !== openTop || bottom !== openBottom) {
        let codes = "\x1b[0m";
        if (top !== null) {
          const [r, g, b] = rgb(top);
          codes += `\x1b[38;2;${r};${g};${b}m`;
        }
        if (bottom !== null) {
          const [r, g, b] = rgb(bottom);
          codes += `\x1b[48;2;${r};${g};${b}m`;
        }
        line += codes;
        openTop = top;
        openBottom = bottom;
      }
      line += (top !== null ? HALF : " ").repeat(scaleX);
    }
    reset();
    lines.push(line);
  }
  return lines;
}

/** Largeur visible (colonnes) qu'occupera le rendu — les séquences ANSI ne
 *  comptent pas. Utile pour aligner un bloc de texte à côté du dessin. */
export function pixelArtWidth(art: PixelArt, scaleX = 2): number {
  return art.vb[0] * Math.max(1, Math.round(scaleX));
}
