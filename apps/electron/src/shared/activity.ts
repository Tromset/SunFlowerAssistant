/** Ce que l'utilisateur est en train de faire, vu de l'extérieur : l'app au
 *  premier plan (et, pour un navigateur, le site ouvert) rangée dans une
 *  poignée de familles. Le compagnon s'en sert pour se donner un petit
 *  accessoire (casque, popcorn, plaid…) quand il n'a rien d'autre à faire.
 *
 *  Purement décoratif et purement LOCAL : rien n'est envoyé nulle part, rien
 *  n'est enregistré sur disque, et la détection s'arrête net dès qu'une
 *  session vocale ou un agent reprend la main sur l'affichage.
 *
 *  Module sans dépendance (ni electron, ni node) : partagé main ↔ renderer et
 *  testable tel quel. */

/** Familles d'activité — « none » = rien de reconnu, tournesol au naturel. */
export type ActivityContext =
  | "none"
  /** Deezer, Spotify, Apple Music… → petit casque. */
  | "music"
  /** Cursor, VS Code, un terminal… → petit ordinateur portable. */
  | "coding"
  /** Claude, ChatGPT, Gemini… → pancarte « AI on top ». */
  | "ai"
  /** YouTube, Netflix, Twitch… → popcorn. */
  | "streaming"
  /** Figma, Premiere Pro, Photoshop… → plaid, courbé sur son écran. */
  | "creative"
  /** Snapchat, Discord, WhatsApp… → téléphone, il envoie des messages. */
  | "messaging"
  /** TikTok, Instagram, Reddit… → téléphone, courbé et épuisé. */
  | "doomscroll";

/** Toutes les familles décorées (ordre d'affichage dans la doc/les réglages). */
export const ACTIVITY_CONTEXTS: readonly ActivityContext[] = [
  "music",
  "coding",
  "ai",
  "streaming",
  "creative",
  "messaging",
  "doomscroll",
] as const;

/** Petite phrase montrée dans le panneau (et utile aux tests de lisibilité). */
export const ACTIVITY_LABELS: Record<ActivityContext, string> = {
  none: "no mood",
  music: "listening to music",
  coding: "coding",
  ai: "talking to another AI",
  streaming: "watching something",
  creative: "creating something",
  messaging: "chatting",
  doomscroll: "doomscrolling",
};

/** Ce que la détection a réellement observé (diagnostic + tests). */
export interface ActivitySnapshot {
  context: ActivityContext;
  /** Nom de l'app au premier plan, tel que rendu par macOS. */
  app: string;
  /** Hôte du site ouvert quand l'app est un navigateur ; vide sinon. */
  host: string;
}

/** Navigateurs pilotables : pour eux, c'est le SITE qui décide, pas l'app. */
export const BROWSERS: readonly string[] = [
  "Safari",
  "Safari Technology Preview",
  "Google Chrome",
  "Google Chrome Canary",
  "Chromium",
  "Brave Browser",
  "Microsoft Edge",
  "Arc",
  "Dia",
  "Vivaldi",
  "Opera",
  "Orion",
  "Zen Browser",
  "Firefox",
] as const;

export function isBrowser(app: string): boolean {
  return BROWSERS.some((b) => b.toLowerCase() === app.toLowerCase());
}

/** Applications natives → famille. Comparaison insensible à la casse sur le
 *  nom EXACT rendu par macOS, puis repli sur une inclusion (« Visual Studio
 *  Code - Insiders » doit rester du code). */
const APP_RULES: [ActivityContext, string[]][] = [
  [
    "music",
    ["deezer", "spotify", "music", "apple music", "tidal", "soundcloud", "youtube music", "vlc", "swinsian", "qobuz"],
  ],
  [
    "coding",
    [
      "cursor", "code", "visual studio code", "vscodium", "windsurf", "zed",
      "xcode", "terminal", "iterm", "iterm2", "warp", "ghostty", "kitty",
      "alacritty", "hyper", "sublime text", "nova", "intellij idea", "webstorm",
      "pycharm", "android studio", "neovim", "vim", "emacs", "fleet",
      "github desktop", "tower", "fork", "sourcetree",
    ],
  ],
  ["ai", ["claude", "chatgpt", "gemini", "perplexity", "copilot", "ollama", "lm studio", "msty", "jan"]],
  ["streaming", ["netflix", "youtube", "twitch", "disney+", "prime video", "plex", "iina", "quicktime player", "mpv", "infuse"]],
  [
    "creative",
    [
      "figma", "sketch", "framer", "adobe premiere pro", "premiere pro",
      "adobe photoshop", "photoshop", "adobe illustrator", "illustrator",
      "adobe after effects", "after effects", "adobe indesign", "indesign",
      "adobe lightroom", "lightroom", "final cut pro", "motion", "compressor",
      "davinci resolve", "blender", "cinema 4d", "affinity photo",
      "affinity designer", "affinity publisher", "logic pro", "ableton live",
      "pixelmator pro", "capcut", "canva", "procreate",
    ],
  ],
  [
    "messaging",
    [
      "snapchat", "discord", "messages", "whatsapp", "telegram", "signal",
      "slack", "messenger", "microsoft teams", "teams", "zoom", "skype",
      "mail", "spark", "superhuman", "linear", "notion calendar",
    ],
  ],
  ["doomscroll", ["tiktok", "instagram", "threads", "x", "twitter", "reddit", "bereal", "pinterest", "tumblr"]],
];

/** Hôtes (sans « www. ») → famille. Le suffixe compte : « open.spotify.com »
 *  et « spotify.com » tombent tous les deux sur `spotify.com`. */
const HOST_RULES: [ActivityContext, string[]][] = [
  ["music", ["deezer.com", "spotify.com", "music.apple.com", "tidal.com", "soundcloud.com", "bandcamp.com", "music.youtube.com", "qobuz.com"]],
  [
    "coding",
    [
      "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com",
      "codesandbox.io", "stackblitz.com", "replit.com", "vercel.com",
      "developer.mozilla.org", "npmjs.com", "crates.io", "pkg.go.dev",
      "cursor.com", "code.visualstudio.com", "codeberg.org",
    ],
  ],
  [
    "ai",
    [
      "claude.ai", "anthropic.com", "chatgpt.com", "chatgpt.ai",
      "chat.openai.com", "openai.com", "gemini.google.com", "aistudio.google.com",
      "perplexity.ai", "mistral.ai", "huggingface.co", "poe.com",
      "copilot.microsoft.com", "grok.com", "deepseek.com",
    ],
  ],
  [
    "streaming",
    [
      "youtube.com", "youtu.be", "netflix.com", "twitch.tv", "disneyplus.com",
      "primevideo.com", "max.com", "hulu.com", "crunchyroll.com",
      "canalplus.com", "arte.tv", "france.tv", "dailymotion.com", "vimeo.com",
    ],
  ],
  [
    "creative",
    [
      "figma.com", "framer.com", "canva.com", "dribbble.com", "behance.net",
      "adobe.com", "photopea.com", "spline.design", "rive.app", "penpot.app",
    ],
  ],
  [
    "messaging",
    [
      "snapchat.com", "discord.com", "web.whatsapp.com", "whatsapp.com",
      "web.telegram.org", "telegram.org", "slack.com", "messenger.com",
      "teams.microsoft.com", "mail.google.com", "outlook.com", "zoom.us",
    ],
  ],
  [
    "doomscroll",
    [
      "tiktok.com", "instagram.com", "threads.net", "threads.com", "x.com",
      "twitter.com", "reddit.com", "9gag.com", "pinterest.com", "tumblr.com",
      "bsky.app",
    ],
  ],
];

/** « https://open.spotify.com/intl-fr/ » → « open.spotify.com ». Jamais
 *  d'exception : une URL illisible rend une chaîne vide. */
export function hostOf(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    // Pas une URL absolue (about:blank, chrome://newtab, saisie partielle).
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([^/?#\s]+)/i.exec(trimmed);
    return (m?.[1] ?? "").toLowerCase();
  }
}

function matchApp(app: string): ActivityContext {
  const name = app.trim().toLowerCase();
  if (!name) return "none";
  for (const [context, needles] of APP_RULES) {
    if (needles.includes(name)) return context;
  }
  // Repli : « Visual Studio Code - Insiders », « Discord Canary »… Les entrées
  // trop courtes (« x », « code ») sont exclues du repli pour ne pas attraper
  // n'importe quel nom d'app qui les contient.
  for (const [context, needles] of APP_RULES) {
    for (const needle of needles) {
      if (needle.length >= 5 && name.includes(needle)) return context;
    }
  }
  return "none";
}

function matchHost(host: string): ActivityContext {
  const h = host.trim().toLowerCase();
  if (!h) return "none";
  for (const [context, domains] of HOST_RULES) {
    for (const domain of domains) {
      if (h === domain || h.endsWith(`.${domain}`)) return context;
    }
  }
  return "none";
}

/**
 * Range une observation (app au premier plan + URL éventuelle) dans une
 * famille. Le site l'emporte sur le navigateur : « Chrome sur netflix.com »
 * est du streaming, pas « une app nommée Chrome ». Un navigateur sur un site
 * inconnu ne décore rien plutôt que de mentir.
 */
export function classifyActivity(app: string, url = ""): ActivitySnapshot {
  const host = hostOf(url);
  if (isBrowser(app)) {
    return { context: matchHost(host), app, host };
  }
  const byApp = matchApp(app);
  // App non-navigateur, mais qui expose quand même une URL (Electron wrappers) :
  // le site sert de second avis quand le nom d'app ne dit rien.
  return {
    context: byApp === "none" ? matchHost(host) : byApp,
    app,
    host,
  };
}
