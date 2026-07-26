// Ce que Sunflower Work a le droit d'ouvrir.
//
// `open` est le seul geste du répertoire qui fasse apparaître quelque chose
// que l'utilisateur n'avait pas à l'écran : c'est le seul dont le rayon
// d'action dépasse le pixel visé. D'où ce garde-fou, pur et testable, dans
// l'esprit de shell-guard.ts — sauf qu'ici la liste noire ne fait pas de
// « best effort » : ce qui n'est pas explicitement reconnu est refusé.
//
// Deux formes acceptées, rien d'autre :
//  - une page en http(s) — tout autre schéma (file:, javascript:, ssh:,
//    x-apple-…, shortcuts:) est un moyen détourné de lancer autre chose ;
//  - un nom d'application, sans chemin (le gabarit exclut « / »), refusé s'il
//    ressemble à un terminal ou à un réglage système.
//
// Le refus n'arrête JAMAIS la course : le runner l'inscrit comme un appel en
// erreur, le redit au modèle, et le tour suivant essaie autre chose.

/** Au-delà, ce n'est plus une cible : le modèle divague. */
export const MAX_TARGET_LENGTH = 200;
/** Nom d'app : pas de chemin, pas de guillemet, pas de séparateur de shell. */
const APP_NAME = /^[A-Za-z0-9 .+-]{1,40}$/;
/** Domaine nu (« github.com/notifications ») écrit sans schéma. */
const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i;

/** Comparaison insensible à la casse, aux espaces et à la ponctuation :
 *  « iTerm 2 », « iterm2 » et « iTerm2.app » sont le même refus. */
const normalize = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Fragments interdits, cherchés DANS le nom normalisé — un préfixe ou un
 *  suffixe ne doit pas suffire à passer. */
const BLOCKED_APPS: { fragment: string; why: string }[] = [
  { fragment: "terminal", why: "a terminal" },
  { fragment: "iterm", why: "a terminal" },
  { fragment: "warp", why: "a terminal" },
  { fragment: "alacritty", why: "a terminal" },
  { fragment: "kitty", why: "a terminal" },
  { fragment: "wezterm", why: "a terminal" },
  { fragment: "hyper", why: "a terminal" },
  { fragment: "tabby", why: "a terminal" },
  { fragment: "ghostty", why: "a terminal" },
  { fragment: "systemsettings", why: "system settings" },
  { fragment: "systempreferences", why: "system settings" },
  { fragment: "keychain", why: "the keychain" },
  { fragment: "scripteditor", why: "a script runner" },
  { fragment: "automator", why: "a script runner" },
  { fragment: "shortcuts", why: "a script runner" },
  { fragment: "console", why: "a system utility" },
  { fragment: "activitymonitor", why: "a system utility" },
  { fragment: "diskutility", why: "a system utility" },
  { fragment: "migrationassistant", why: "a system utility" },
];

export type OpenTarget =
  | { kind: "url"; url: string }
  | { kind: "app"; name: string }
  | { kind: "blocked"; reason: string };

/**
 * Décide ce que `open` recevra — ou pourquoi il ne recevra rien.
 *
 * La `reason` est montrée telle quelle à l'utilisateur ET reservie au modèle,
 * donc elle est en anglais et dit ce qui a coincé, pas seulement « refusé ».
 */
export function resolveOpenTarget(raw: string): OpenTarget {
  const target = raw.trim().replace(/^["']|["']$/g, "");
  if (!target) return { kind: "blocked", reason: "nothing to open." };
  if (target.length > MAX_TARGET_LENGTH) {
    return { kind: "blocked", reason: "that target is far too long." };
  }

  // -- Une adresse : le schéma décide, et deux schémas seulement passent.
  const looksLikeUrl =
    target.includes("://") || /^[a-z][a-z0-9+.-]*:/i.test(target);
  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return { kind: "blocked", reason: `"${target.slice(0, 60)}" is not a valid URL.` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        kind: "blocked",
        reason: `${url.protocol} links are off limits — http and https only.`,
      };
    }
    return { kind: "url", url: url.toString() };
  }
  // « Terminal.app » : c'est comme ça que macOS nomme un bundle, et c'est donc
  // comme ça que le modèle l'écrit — mais `.app` est AUSSI un vrai TLD, donc
  // sans ce cas le nom filait au test de domaine nu juste en dessous, devenait
  // https://terminal.app, et passait à côté de la liste noire. Le suffixe est
  // tranché ici, avant de renifler une adresse : un nom d'app gagne.
  const bundle = /^(.+)\.app$/i.exec(target);
  if (bundle?.[1]) return resolveAppName(bundle[1]);
  // Domaine nu : on complète en https plutôt que de laisser `open` deviner.
  if (BARE_DOMAIN.test(target)) {
    try {
      return { kind: "url", url: new URL(`https://${target}`).toString() };
    } catch {
      return { kind: "blocked", reason: `"${target.slice(0, 60)}" is not a valid URL.` };
    }
  }

  return resolveAppName(target);
}

/** Une application : gabarit strict, puis liste noire. */
function resolveAppName(name: string): OpenTarget {
  if (!APP_NAME.test(name)) {
    return {
      kind: "blocked",
      reason: `"${name.slice(0, 60)}" is neither an app name nor a web address.`,
    };
  }
  const flat = normalize(name);
  for (const { fragment, why } of BLOCKED_APPS) {
    if (flat.includes(fragment)) {
      return { kind: "blocked", reason: `won't open ${why}.` };
    }
  }
  return { kind: "app", name };
}
