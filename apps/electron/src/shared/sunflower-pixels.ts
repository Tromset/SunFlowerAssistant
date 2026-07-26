/**
 * Pixel-art rects of the sunflower, lifted pixel-perfect from the prototype
 * (SunFlower.dc.html, surfaces 1a/1c/1d/1e). Consumed as SVG on the renderer
 * side and rasterized to PNG on the main side (tray icon).
 */
import type { ActivityContext } from "./activity";

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  c: string;
}

export interface PixelLayer {
  /** Optional SVG transform (pointing rotation). */
  transform?: string;
  /** Optional CSS class on the layer's <g> — used by the companion to animate
      individual parts of an activity vignette (screen glow, magnifier, wrench). */
  cls?: string;
  rects: PixelRect[];
}

export interface PixelArt {
  /** [width, height] of the viewBox. */
  vb: [number, number];
  layers: PixelLayer[];
}

const Y = "#FCD232"; // petals
const B = "#8B5A2B"; // core
const BK = "#141413"; // black (bee stripes)
const G1 = "#458149"; // light stem
const G2 = "#3C6E41"; // dark stem
const G3 = "#325A38"; // base
const O = "#D97757"; // clay accent
const HL = "#F6E3D7"; // reading glint
const DK = "#2B2A28"; // hardware near-black (laptop, wrench, loupe rim)

/** Base flower (idle pose), viewBox 8×9. */
const BASE: PixelRect[] = [
  { x: 2, y: 0, w: 4, h: 2, c: Y },
  { x: 0, y: 2, w: 8, h: 2, c: Y },
  { x: 2, y: 4, w: 4, h: 1, c: Y },
  { x: 3, y: 2, w: 2, h: 2, c: B },
  { x: 3, y: 5, w: 1, h: 3, c: G1 },
  { x: 4, y: 5, w: 1, h: 3, c: G2 },
  { x: 3, y: 8, w: 2, h: 1, c: G3 },
];

/** Open petals — the island (1c) only opens the top two, the companion
    pose (1d) all four. */
const OPEN_PETALS_TOP: PixelRect[] = [
  { x: 1, y: 1, w: 1, h: 1, c: Y },
  { x: 6, y: 1, w: 1, h: 1, c: Y },
];
const OPEN_PETALS: PixelRect[] = [
  ...OPEN_PETALS_TOP,
  { x: 1, y: 4, w: 1, h: 1, c: Y },
  { x: 6, y: 4, w: 1, h: 1, c: Y },
];

/** Island "listening" icon (surface 1c) — top petals only. */
export const ISLAND_LISTENING: PixelArt = {
  vb: [8, 9],
  layers: [{ rects: [...BASE, ...OPEN_PETALS_TOP] }],
};

/** Speech mark (answering). */
const SPEECH: PixelRect[] = [
  { x: 9, y: 2, w: 1, h: 1, c: O },
  { x: 9, y: 4, w: 1, h: 1, c: O },
  { x: 10, y: 3, w: 1, h: 1, c: O },
];

export const POSES = {
  idle: { vb: [8, 9], layers: [{ rects: BASE }] },
  listening: { vb: [8, 9], layers: [{ rects: [...BASE, ...OPEN_PETALS] }] },
  reading: {
    vb: [8, 9],
    layers: [{ rects: [...BASE, { x: 3, y: 2, w: 1, h: 1, c: HL }] }],
  },
  // Le tournesol de base : les anciens « points » de réflexion sont
  // désormais des abeilles (BEE) que le companion fait tourner autour de la
  // tête en CSS (voir companion.css / companion.ts).
  thinking: { vb: [8, 9], layers: [{ rects: BASE }] },
  answering: { vb: [12, 9], layers: [{ rects: [...BASE, ...SPEECH] }] },
  pointing: {
    vb: [12, 11],
    layers: [
      { transform: "rotate(8 4 9)", rects: BASE },
      {
        rects: [
          { x: 9, y: 7, w: 1, h: 1, c: O },
          { x: 10, y: 8, w: 1, h: 1, c: O },
          { x: 11, y: 9, w: 1, h: 1, c: O },
        ],
      },
    ],
  },
} satisfies Record<string, PixelArt>;

/* ── Vignettes d'activité du companion ─────────────────────────────────
   Petites scènes du tournesol « en train de faire quelque chose », posées à
   côté de la fleur. Chaque scène range ses parties animables dans une couche
   à part (cls) : companion.css les anime uniquement tant que #flower porte la
   classe de la pose (aucune boucle ne fuit hors de l'état). Palette + grille
   identiques au reste du fichier. viewBox large (≤14) pour rester dans #flower. */

/** « coding » : le tournesol tape sur un petit portable, l'écran clignote
    (glow) et la fleur pianote (petit rebond). */
export const CODING: PixelArt = {
  vb: [14, 9],
  layers: [
    // La fleur qui pianote (rebond en CSS via .sf-typer).
    { cls: "sf-typer", rects: BASE },
    // Le portable : châssis + écran + lignes de « code » aux couleurs de la
    // palette (comme une coloration syntaxique).
    {
      rects: [
        { x: 8, y: 7, w: 6, h: 1, c: DK }, // socle / clavier
        { x: 8, y: 2, w: 6, h: 5, c: DK }, // cadre de l'écran
        { x: 9, y: 3, w: 4, h: 3, c: BK }, // dalle
        { x: 9, y: 3, w: 2, h: 1, c: O }, // ligne de code
        { x: 9, y: 4, w: 3, h: 1, c: G1 }, // ligne de code
        { x: 9, y: 5, w: 2, h: 1, c: Y }, // ligne de code
        { x: 12, y: 4, w: 1, h: 1, c: HL }, // curseur
      ],
    },
    // Halo de l'écran (opacité modulée en CSS → scintillement).
    { cls: "sf-glow", rects: [{ x: 9, y: 3, w: 4, h: 3, c: HL }] },
  ],
};

/** « reading » : le tournesol examine un document avec une loupe qui balaie la
    page (analyse de la capture d'écran). */
export const READING: PixelArt = {
  vb: [14, 9],
  layers: [
    { rects: BASE },
    // La feuille et ses lignes de texte.
    {
      rects: [
        { x: 8, y: 5, w: 6, h: 4, c: HL }, // page
        { x: 9, y: 5, w: 3, h: 1, c: B }, // texte
        { x: 9, y: 6, w: 4, h: 1, c: B }, // texte
        { x: 9, y: 7, w: 2, h: 1, c: B }, // texte
      ],
    },
    // La loupe (balayage gauche/droite en CSS via .sf-magnify).
    {
      cls: "sf-magnify",
      rects: [
        { x: 10, y: 3, w: 2, h: 1, c: DK }, // monture haut
        { x: 10, y: 6, w: 2, h: 1, c: DK }, // monture bas
        { x: 9, y: 4, w: 1, h: 2, c: DK }, // monture gauche
        { x: 12, y: 4, w: 1, h: 2, c: DK }, // monture droite
        { x: 10, y: 4, w: 2, h: 2, c: HL }, // verre
        { x: 10, y: 5, w: 2, h: 1, c: B }, // texte grossi
        { x: 12, y: 6, w: 1, h: 1, c: B }, // manche
        { x: 13, y: 7, w: 1, h: 1, c: B }, // manche
      ],
    },
  ],
};

/** « working » : tournesol casqué qui serre un boulon avec une clé (exécution
    d'un outil / d'une action). La clé oscille, une étincelle clignote. */
export const WORKING: PixelArt = {
  vb: [14, 9],
  layers: [
    // Fleur + casque de chantier (clay).
    {
      rects: [
        ...BASE,
        { x: 2, y: 0, w: 4, h: 1, c: O }, // dôme du casque
        { x: 1, y: 1, w: 6, h: 1, c: O }, // bord du casque
      ],
    },
    // Le boulon serré (fixe, la clé tourne autour).
    { rects: [{ x: 11, y: 3, w: 1, h: 1, c: B }] },
    // La clé (oscillation en CSS via .sf-wrench).
    {
      cls: "sf-wrench",
      rects: [
        { x: 10, y: 4, w: 3, h: 1, c: DK }, // tête
        { x: 10, y: 3, w: 1, h: 1, c: DK }, // mâchoire gauche
        { x: 12, y: 3, w: 1, h: 1, c: DK }, // mâchoire droite
        { x: 11, y: 5, w: 1, h: 1, c: DK }, // col
        { x: 11, y: 6, w: 1, h: 2, c: DK }, // manche
        { x: 11, y: 6, w: 1, h: 1, c: HL }, // reflet
      ],
    },
    // Étincelles de travail (clignotent en CSS via .sf-spark).
    {
      cls: "sf-spark",
      rects: [
        { x: 13, y: 2, w: 1, h: 1, c: HL },
        { x: 9, y: 3, w: 1, h: 1, c: HL },
      ],
    },
  ],
};

/* ── Humeurs contextuelles ─────────────────────────────────────────────
   Le tournesol se donne un petit accessoire selon ce que l'utilisateur est
   en train de faire (voir shared/activity.ts pour le classement et
   main/activity.ts pour la détection) : casque quand ça écoute de la musique,
   popcorn devant une vidéo, plaid devant Figma, téléphone sur Discord…
   Mêmes règles que les vignettes ci-dessus : une couche `cls` par partie
   animable, animations 100 % CSS scopées à la classe portée par #flower, donc
   rien ne tourne hors de l'humeur concernée. viewBox 14×10. */

/** Décale une liste de rects (les humeurs descendent la fleur d'un cran pour
    lui poser quelque chose sur la tête). */
function shift(rects: PixelRect[], dx: number, dy: number): PixelRect[] {
  return rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
}

/** Fleur descendue d'un cran : la tête occupe y1..y5, la tige y6..y9. */
const BASE_DOWN = shift(BASE, 0, 1);

/** « music » : petit casque sur la tête, deux notes qui s'envolent. */
export const MOOD_MUSIC: PixelArt = {
  vb: [14, 10],
  layers: [
    { rects: BASE_DOWN },
    // Arceau + oreillettes.
    {
      rects: [
        { x: 2, y: 0, w: 4, h: 1, c: DK }, // arceau
        { x: 1, y: 1, w: 1, h: 1, c: DK }, // branche gauche
        { x: 6, y: 1, w: 1, h: 1, c: DK }, // branche droite
        { x: 0, y: 2, w: 1, h: 3, c: DK }, // oreillette gauche
        { x: 7, y: 2, w: 1, h: 3, c: DK }, // oreillette droite
        { x: 0, y: 3, w: 1, h: 1, c: O }, // coussinet
        { x: 7, y: 3, w: 1, h: 1, c: O }, // coussinet
      ],
    },
    // Deux croches qui montent (animées séparément pour se décaler).
    {
      cls: "sf-note-1",
      rects: [
        { x: 10, y: 4, w: 2, h: 1, c: O }, // tête
        { x: 11, y: 1, w: 1, h: 3, c: O }, // hampe
        { x: 12, y: 1, w: 1, h: 1, c: O }, // crochet
      ],
    },
    {
      cls: "sf-note-2",
      rects: [
        { x: 9, y: 8, w: 1, h: 1, c: Y }, // tête
        { x: 10, y: 6, w: 1, h: 3, c: Y }, // hampe (jusqu'au niveau de la tête)
      ],
    },
  ],
};

/** « ai » : le tournesol brandit une pancarte « AI » (lettres pixel de 4
    rangées — il en faut quatre pour que le A garde son trou — dans un cadre
    crème), agitée doucement. */
export const MOOD_AI: PixelArt = {
  vb: [14, 10],
  layers: [
    { rects: BASE_DOWN },
    // Manche de la pancarte.
    { rects: [{ x: 10, y: 6, w: 1, h: 3, c: B }] },
    {
      cls: "sf-sign",
      rects: [
        // Panneau 7×6 : il faut ces sept colonnes pour caser A + espace + I
        // avec une marge de chaque côté — collées, les lettres redeviennent
        // une tache. Son bord gauche mord d'un pixel sur la fleur : la
        // pancarte est tenue DEVANT, c'est ce qu'on veut.
        { x: 7, y: 0, w: 7, h: 6, c: HL },
        // « A » : barre haute, flancs, barre transversale, jambes.
        { x: 8, y: 1, w: 3, h: 1, c: BK },
        { x: 8, y: 2, w: 1, h: 1, c: BK },
        { x: 10, y: 2, w: 1, h: 1, c: BK },
        { x: 8, y: 3, w: 3, h: 1, c: BK },
        { x: 8, y: 4, w: 1, h: 1, c: BK },
        { x: 10, y: 4, w: 1, h: 1, c: BK },
        // « I », séparé du A par une colonne vide.
        { x: 12, y: 1, w: 1, h: 4, c: BK },
      ],
    },
  ],
};

/** « streaming » : seau de popcorn rayé, un grain saute. */
export const MOOD_STREAMING: PixelArt = {
  vb: [14, 10],
  layers: [
    { rects: BASE_DOWN },
    // Grains qui dépassent du seau.
    {
      rects: [
        { x: 9, y: 4, w: 1, h: 1, c: HL },
        { x: 10, y: 3, w: 1, h: 1, c: Y },
        { x: 11, y: 4, w: 1, h: 1, c: HL },
        { x: 12, y: 3, w: 1, h: 1, c: HL },
        { x: 13, y: 4, w: 1, h: 1, c: Y },
      ],
    },
    // Seau rayé clay / crème.
    {
      rects: [
        { x: 9, y: 5, w: 1, h: 5, c: O },
        { x: 10, y: 5, w: 1, h: 5, c: HL },
        { x: 11, y: 5, w: 1, h: 5, c: O },
        { x: 12, y: 5, w: 1, h: 5, c: HL },
        { x: 13, y: 5, w: 1, h: 5, c: O },
        { x: 9, y: 5, w: 5, h: 1, c: HL }, // rebord
      ],
    },
    // Le grain qui saute (animé en CSS).
    { cls: "sf-pop", rects: [{ x: 11, y: 2, w: 1, h: 1, c: Y }] },
  ],
};

/** « creative » : tournesol courbé sous un plaid, face à un écran qui
    scintille (Figma, Premiere…). */
export const MOOD_CREATIVE: PixelArt = {
  vb: [14, 10],
  layers: [
    // Fleur penchée vers l'écran.
    { transform: "rotate(10 4 10)", rects: BASE_DOWN },
    // Plaid à carreaux posé sur les épaules : fond brun, carreaux clay. Un
    // fond clay avec des carreaux crème donnait une nappe de pique-nique.
    {
      rects: [
        { x: 1, y: 5, w: 6, h: 4, c: B },
        { x: 2, y: 5, w: 1, h: 1, c: O },
        { x: 4, y: 5, w: 1, h: 1, c: O },
        { x: 6, y: 5, w: 1, h: 1, c: O },
        { x: 1, y: 6, w: 1, h: 1, c: O },
        { x: 3, y: 6, w: 1, h: 1, c: O },
        { x: 5, y: 6, w: 1, h: 1, c: O },
        { x: 2, y: 7, w: 1, h: 1, c: O },
        { x: 4, y: 7, w: 1, h: 1, c: O },
        { x: 6, y: 7, w: 1, h: 1, c: O },
        { x: 1, y: 8, w: 1, h: 1, c: O },
        { x: 3, y: 8, w: 1, h: 1, c: O },
        { x: 5, y: 8, w: 1, h: 1, c: O },
      ],
    },
    // L'écran, sur son pied.
    {
      rects: [
        { x: 8, y: 2, w: 6, h: 5, c: DK }, // cadre
        { x: 9, y: 3, w: 4, h: 3, c: BK }, // dalle
        { x: 9, y: 3, w: 2, h: 1, c: O }, // calque
        { x: 9, y: 4, w: 1, h: 1, c: Y }, // calque
        { x: 11, y: 5, w: 2, h: 1, c: G1 }, // calque
        { x: 10, y: 7, w: 2, h: 1, c: DK }, // pied
        { x: 9, y: 8, w: 4, h: 1, c: DK }, // socle
      ],
    },
    // Halo de l'écran (opacité modulée en CSS).
    { cls: "sf-screen", rects: [{ x: 9, y: 3, w: 4, h: 3, c: HL }] },
  ],
};

/** Téléphone pixel réutilisé par « messaging » et « doomscroll ». */
function phoneRects(x: number, y: number): PixelRect[] {
  return [
    { x, y, w: 4, h: 6, c: DK }, // châssis
    { x: x + 1, y: y + 1, w: 2, h: 4, c: BK }, // dalle
  ];
}

/** « messaging » : téléphone en main, petites bulles qui s'envolent. */
export const MOOD_MESSAGING: PixelArt = {
  vb: [14, 10],
  layers: [
    { rects: BASE_DOWN },
    // Le téléphone, écran allumé.
    {
      rects: [
        ...phoneRects(8, 4),
        { x: 9, y: 5, w: 2, h: 1, c: HL }, // ligne de message
        { x: 9, y: 7, w: 1, h: 1, c: Y }, // ligne de message
      ],
    },
    // Bulles qui montent (animées séparément).
    {
      cls: "sf-msg-1",
      rects: [
        { x: 12, y: 2, w: 2, h: 2, c: O },
        { x: 12, y: 4, w: 1, h: 1, c: O }, // pointe
      ],
    },
    {
      cls: "sf-msg-2",
      rects: [{ x: 12, y: 6, w: 1, h: 1, c: HL }],
    },
  ],
};

/** « doomscroll » : tournesol affalé, deux pétales tombés, téléphone collé
    au visage et petit « zzz » — la version fatiguée. */
export const MOOD_DOOMSCROLL: PixelArt = {
  vb: [14, 10],
  layers: [
    // Fleur nettement courbée, pétales du haut fanés (brun).
    // 12° et pas plus : au-delà, la tête part si loin sur la droite que la
    // fleur a l'air cassée plutôt qu'avachie.
    {
      transform: "rotate(12 4 10)",
      rects: [
        // Le bloc de pétales du haut (y1..y2) est retiré puis repeint en brun :
        // il couvre DEUX rangées, sinon il resterait un trou en y2.
        ...BASE_DOWN.filter((r) => !(r.y === 1 && r.c === Y)),
        { x: 2, y: 1, w: 4, h: 2, c: B }, // pétales fanés
      ],
    },
    // Deux pétales tombés au sol.
    {
      rects: [
        { x: 1, y: 9, w: 1, h: 1, c: Y },
        { x: 6, y: 9, w: 1, h: 1, c: B },
      ],
    },
    // Le téléphone, tenu tout près, écran blafard.
    {
      rects: [
        ...phoneRects(7, 3),
        { x: 8, y: 4, w: 2, h: 1, c: HL },
        { x: 8, y: 6, w: 2, h: 1, c: HL },
      ],
    },
    // Lueur du téléphone sur le visage (pulsation lente).
    { cls: "sf-doom-glow", rects: [{ x: 8, y: 4, w: 2, h: 4, c: HL }] },
    // Un « z » de sommeil. Trois colonnes, pas deux : sur deux, la diagonale
    // n'a pas où passer et la lettre se lit « c ».
    {
      cls: "sf-zzz",
      rects: [
        { x: 11, y: 0, w: 3, h: 1, c: HL },
        { x: 12, y: 1, w: 1, h: 1, c: HL },
        { x: 11, y: 2, w: 3, h: 1, c: HL },
      ],
    },
  ],
};

/** Humeur → scène. « none » n'a pas de scène : le tournesol reste au naturel
    (POSES.idle). « coding » réutilise la vignette du portable, déjà dessinée
    pour la pose « coding » — même geste, même dessin. */
export const MOOD_ART: Record<ActivityContext, PixelArt | null> = {
  none: null,
  music: MOOD_MUSIC,
  coding: CODING,
  ai: MOOD_AI,
  streaming: MOOD_STREAMING,
  creative: MOOD_CREATIVE,
  messaging: MOOD_MESSAGING,
  doomscroll: MOOD_DOOMSCROLL,
};

/** Petite abeille pixel (animation « thinking » du companion) : corps rayé
    jaune/noir avec une tête sombre et deux ailes claires. viewBox 4×3. */
export const BEE: PixelArt = {
  vb: [4, 3],
  layers: [
    {
      rects: [
        // ailes
        { x: 1, y: 0, w: 1, h: 1, c: HL },
        { x: 2, y: 0, w: 1, h: 1, c: HL },
        // corps : tête sombre puis rayures jaune / noir
        { x: 0, y: 1, w: 1, h: 2, c: BK },
        { x: 1, y: 1, w: 1, h: 2, c: Y },
        { x: 2, y: 1, w: 1, h: 2, c: BK },
        { x: 3, y: 1, w: 1, h: 2, c: Y },
      ],
    },
  ],
};

/** Menu-bar icon using the proper sunflower palette (yellow petals, brown core, green stem). */
function menubarArt(core: string): PixelArt {
  return {
    vb: [8, 9],
    layers: [
      {
        rects: [
          { x: 2, y: 0, w: 4, h: 2, c: Y },
          { x: 0, y: 2, w: 8, h: 2, c: Y },
          { x: 2, y: 4, w: 4, h: 1, c: Y },
          { x: 3, y: 2, w: 2, h: 2, c: core },
          { x: 3, y: 5, w: 1, h: 3, c: G1 },
          { x: 4, y: 5, w: 1, h: 3, c: G2 },
        ],
      },
    ],
  };
}
export const MENUBAR: PixelArt = menubarArt(B);
export const MENUBAR_DARK: PixelArt = menubarArt(B);

/** Field sunflower (footers 1a/1e) — simple stem. */
export const FIELD: PixelArt = {
  vb: [8, 9],
  layers: [
    {
      rects: [
        { x: 2, y: 0, w: 4, h: 2, c: Y },
        { x: 0, y: 2, w: 8, h: 2, c: Y },
        { x: 2, y: 4, w: 4, h: 1, c: Y },
        { x: 3, y: 2, w: 2, h: 2, c: B },
        { x: 3, y: 5, w: 1, h: 4, c: G1 },
      ],
    },
  ],
};

/** Pointing brackets (surface 1a), viewBox 30×18. */
export const BRACKETS: PixelArt = {
  vb: [30, 18],
  layers: [
    {
      rects: [
        { x: 0, y: 0, w: 4, h: 1, c: O },
        { x: 0, y: 0, w: 1, h: 4, c: O },
        { x: 26, y: 0, w: 4, h: 1, c: O },
        { x: 29, y: 0, w: 1, h: 4, c: O },
        { x: 0, y: 17, w: 4, h: 1, c: O },
        { x: 0, y: 14, w: 1, h: 4, c: O },
        { x: 26, y: 17, w: 4, h: 1, c: O },
        { x: 29, y: 14, w: 1, h: 4, c: O },
      ],
    },
  ],
};

export function pixelArtSvg(
  art: PixelArt,
  width: number,
  height: number,
  extraAttrs = "",
): string {
  const [vw, vh] = art.vb;
  const layers = art.layers
    .map((layer) => {
      const rects = layer.rects
        .map(
          (r) =>
            `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.c}"></rect>`,
        )
        .join("");
      if (!layer.transform && !layer.cls) return rects;
      const attrs = [
        layer.cls ? `class="${layer.cls}"` : "",
        layer.transform ? `transform="${layer.transform}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<g ${attrs}>${rects}</g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${vw} ${vh}" width="${width}" height="${height}" shape-rendering="crispEdges" aria-hidden="true" ${extraAttrs}>${layers}</svg>`;
}

/** Crochets adaptatifs : quatre coins d'un cadre w×h px, épaisseur de bras
 *  constante (1 cellule de 4 px). Contrairement à `pixelArtSvg(BRACKETS, w, h)`
 *  qui étirerait les bras avec le cadre, la grille reste uniforme : seule la
 *  longueur des bras suit (un quart du petit côté, bornée 12–28 px). */
export function bracketFrameSvg(w: number, h: number): string {
  const u = 4; // px par cellule (grille pixel-art uniforme)
  const cols = Math.max(8, Math.round(w / u));
  const rows = Math.max(6, Math.round(h / u));
  const arm = Math.min(7, Math.max(3, Math.round(Math.min(cols, rows) / 4)));
  const rects: PixelRect[] = [
    // Coin haut-gauche
    { x: 0, y: 0, w: arm, h: 1, c: O },
    { x: 0, y: 0, w: 1, h: arm, c: O },
    // Coin haut-droit
    { x: cols - arm, y: 0, w: arm, h: 1, c: O },
    { x: cols - 1, y: 0, w: 1, h: arm, c: O },
    // Coin bas-gauche
    { x: 0, y: rows - 1, w: arm, h: 1, c: O },
    { x: 0, y: rows - arm, w: 1, h: arm, c: O },
    // Coin bas-droit
    { x: cols - arm, y: rows - 1, w: arm, h: 1, c: O },
    { x: cols - 1, y: rows - arm, w: 1, h: arm, c: O },
  ];
  return pixelArtSvg({ vb: [cols, rows], layers: [{ rects }] }, cols * u, rows * u);
}
