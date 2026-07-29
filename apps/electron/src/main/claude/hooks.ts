/** L'installation du bloc de hooks dans ~/.claude/settings.json.
 *
 *  C'est le SEUL endroit de Sunflower qui écrit hors de ses propres dossiers,
 *  donc le plus méfiant du dépôt. Cinq règles :
 *
 *  1. on ne touche jamais à ce qui n'est pas à nous. Une entrée nous appartient
 *     si et seulement si sa commande contient MARKER — un chemin que nous
 *     possédons. On n'ajoute aucun champ au schéma de Claude, on ne fusionne
 *     jamais dans un groupe étranger, on ne réordonne rien ;
 *  2. fichier illisible = on n'écrit pas. Un JSON invalide (des gens y mettent
 *     des commentaires) rend « unreadable », jamais « on repart de zéro » : ce
 *     fichier peut contenir des heures de réglages ;
 *  3. on n'écrit QUE sur une action explicite de l'utilisateur (case du tray,
 *     /claude on|off). Jamais au démarrage, jamais à la sortie, jamais en
 *     « réparation » silencieuse : c'est ce qui réduit la course avec Claude
 *     Code lui-même à une milliseconde, une fois, quand un humain clique ;
 *  4. la commande est gardée par un `[ -x … ]`. Si quelqu'un efface le dossier
 *     de données de Sunflower en laissant le bloc en place, le hook devient un
 *     no-op — au lieu d'afficher une erreur à CHAQUE tour dans la session de
 *     l'utilisateur, ce qu'une fonctionnalité décorative ne doit jamais faire ;
 *  5. le script est engendré ici, pas livré dans bin/. Un fichier de moins à
 *     empaqueter, et il se met à jour tout seul à chaque activation. */

import { app } from "electron";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_MATCHERS,
  type ClaudeInstallState,
} from "../../shared/claude";

/** Ce qui identifie une entrée comme étant la nôtre, où qu'elle pointe. */
const MARKER = "sunflower/claude/hook.sh";

export interface ClaudePaths {
  /** ~/Library/Application Support/sunflower/claude */
  root: string;
  /** La copie exécutable du hook, celle que settings.json désigne. */
  hookScript: string;
  /** Les fichiers déposés par le hook, un par événement. */
  spool: string;
  /** Copie de settings.json avant notre première écriture. */
  backup: string;
  /** ~/.claude */
  configDir: string;
  /** ~/.claude/settings.json */
  settings: string;
}

export function claudePaths(): ClaudePaths {
  const root = path.join(app.getPath("userData"), "claude");
  // CLAUDE_CONFIG_DIR déplace ~/.claude ; une app lancée depuis le Finder
  // n'hérite pas du shell, donc c'est surtout vrai en lancement terminal.
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return {
    root,
    hookScript: path.join(root, "hook.sh"),
    spool: path.join(root, "spool"),
    backup: path.join(root, "settings-backup.json"),
    configDir,
    settings: path.join(configDir, "settings.json"),
  };
}

/** Guillemets simples du shell : la seule échappatoire est de fermer, poser un
 *  apostrophe littéral, rouvrir. Le chemin contient « Application Support »,
 *  donc une espace : rien ici ne doit être concaténé à la main. */
const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Le script, engendré avec son dossier de spool en dur.
 *
 *  Contraintes, dans l'ordre : ne jamais bloquer Claude (aucun réseau, aucun
 *  verrou, six appels système), ne jamais écrire sur stdout — celui d'un hook
 *  UserPromptSubmit est injecté dans le contexte de Claude, un `echo` égaré
 *  polluerait la conversation — et sortir 0 quoi qu'il arrive : un code non nul
 *  affiche un avertissement dans la session. */
function hookScriptSource(spool: string): string {
  return `#!/bin/sh
# sunflower-hook v1 — écrit par Sunflower, réécrit à chaque activation.
# Lit la charge utile d'un hook Claude Code sur stdin, la dépose dans le spool.
# Ni réseau, ni stdout, ni attente. Sort toujours 0.
set -u
DIR=${shq(spool)}
# Sunflower désinstallé ou dossier effacé : on ne fait rien, sans se plaindre.
[ -d "$DIR" ] || exit 0
# Plafond du spool, en glob pur (aucun processus lancé). Sans correspondance,
# le motif reste littéral et "$#" vaut 1 : bien en dessous de la limite.
set -- "$DIR"/*.json
[ "$#" -gt 200 ] && exit 0
# mktemp EST la primitive d'unicité : création atomique en 0600. Un fichier à
# moitié écrit s'appelle tmp.* et reste donc invisible au lecteur, qui ne
# ramasse que *.json. Deux sessions Claude ne peuvent pas s'entremêler.
TMP=$(/usr/bin/mktemp "$DIR/tmp.XXXXXXXX" 2>/dev/null) || exit 0
/bin/cat > "$TMP" 2>/dev/null
/bin/mv -f "$TMP" "$DIR/\${TMP##*/tmp.}.json" 2>/dev/null \\
  || /bin/rm -f "$TMP" 2>/dev/null
exit 0
`;
}

/** La commande inscrite dans settings.json — gardée, donc inoffensive si le
 *  script disparaît. */
const commandFor = (script: string): string =>
  `[ -x ${shq(script)} ] && ${shq(script)} || true`;

export interface ClaudeInstallResult {
  ok: boolean;
  state: ClaudeInstallState;
  /** Déjà rédigé en anglais : l'app l'affiche tel quel. */
  problem?: string;
}

type Settings = Record<string, unknown>;
type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };

type ReadResult =
  | { ok: true; data: Settings; existed: boolean; stamp: string }
  | { ok: false; problem: string };

/** Empreinte bon marché du fichier, pour repérer une écriture concurrente de
 *  Claude Code entre notre lecture et notre renommage. */
function stampOf(file: string): string {
  try {
    const info = statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

function readSettings(file: string): ReadResult {
  const stamp = stampOf(file);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, data: {}, existed: false, stamp };
    }
    return { ok: false, problem: "Claude's settings file can't be read." };
  }
  // Un fichier vide est légitime : Claude le crée parfois avant d'y écrire.
  if (!raw.trim()) return { ok: true, data: {}, existed: true, stamp };
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, problem: "Claude's settings file isn't a JSON object." };
    }
    return { ok: true, data: data as Settings, existed: true, stamp };
  } catch {
    return {
      ok: false,
      problem: "Claude's settings file isn't valid JSON — left untouched.",
    };
  }
}

function writeSettings(file: string, data: Settings, stamp: string): boolean {
  try {
    // Suivre le lien plutôt que de le remplacer par un fichier ordinaire :
    // ~/.claude/settings.json pointant vers un dépôt de dotfiles est courant.
    const target = existsSync(file) ? realpathSync(file) : file;
    // Dernière vérification avant d'écraser : si le fichier a bougé depuis la
    // lecture, on renonce plutôt que de perdre ce que Claude vient d'y mettre.
    if (stampOf(target) !== stamp && stampOf(file) !== stamp) return false;
    const tmp = path.join(path.dirname(target), ".settings.json.sunflower.tmp");
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

const asGroups = (v: unknown): HookGroup[] =>
  Array.isArray(v) ? (v as HookGroup[]) : [];

const ownsEntry = (entry: HookEntry): boolean =>
  typeof entry?.command === "string" && entry.command.includes(MARKER);

/** Retire toutes nos entrées. Nettoie derrière soi — un groupe que NOUS avons
 *  vidé, un événement vidé et un `hooks` vide disparaissent — pour que
 *  désinstaller rende exactement le fichier d'avant. Un groupe étranger déjà
 *  vide est laissé tel quel : ce n'est pas notre ménage. */
function stripOurs(data: Settings): void {
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== "object") return;
  const table = hooks as Record<string, unknown>;
  for (const event of Object.keys(table)) {
    const groups = asGroups(table[event]);
    if (!groups.length) continue;
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : [];
      const keptEntries = entries.filter((e) => !ownsEntry(e));
      if (keptEntries.length === entries.length) kept.push(group);
      else if (keptEntries.length) kept.push({ ...group, hooks: keptEntries });
    }
    if (kept.length) table[event] = kept;
    else delete table[event];
  }
  if (!Object.keys(table).length) delete data.hooks;
}

function addOurs(data: Settings, script: string): void {
  const table = (data.hooks && typeof data.hooks === "object"
    ? data.hooks
    : (data.hooks = {})) as Record<string, unknown>;
  const command = commandFor(script);
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = asGroups(table[event]);
    const matcher = CLAUDE_HOOK_MATCHERS[event];
    // Toujours NOTRE propre groupe, jamais une fusion dans celui d'un autre.
    groups.push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command, timeout: 5 }],
    });
    table[event] = groups;
  }
}

/** Combien de nos événements sont présents, sans rien modifier. */
function countOurs(data: Settings): number {
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== "object") return 0;
  const table = hooks as Record<string, unknown>;
  let found = 0;
  for (const event of CLAUDE_HOOK_EVENTS) {
    const present = asGroups(table[event]).some((g) =>
      (Array.isArray(g?.hooks) ? g.hooks : []).some(ownsEntry),
    );
    if (present) found++;
  }
  return found;
}

export function hookInstallState(): ClaudeInstallResult {
  const paths = claudePaths();
  if (!existsSync(paths.configDir)) return { ok: true, state: "no-claude" };

  const read = readSettings(paths.settings);
  if (!read.ok) return { ok: false, state: "unreadable", problem: read.problem };

  const found = countOurs(read.data);
  if (!found) return { ok: true, state: "absent" };
  if (read.data.disableAllHooks === true) {
    return {
      ok: false,
      state: "disabled",
      problem: 'Claude\'s settings have "disableAllHooks": true.',
    };
  }
  if (!existsSync(paths.hookScript)) return { ok: false, state: "stale" };
  if (found < CLAUDE_HOOK_EVENTS.length) return { ok: false, state: "partial" };
  return { ok: true, state: "installed" };
}

/** Pose la copie exécutable du hook et le dossier du spool. */
function stageScript(paths: ClaudePaths): string | null {
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    mkdirSync(paths.spool, { recursive: true, mode: 0o700 });
    writeFileSync(paths.hookScript, hookScriptSource(paths.spool), {
      mode: 0o700,
    });
    chmodSync(paths.hookScript, 0o700);
    return null;
  } catch {
    return "Sunflower couldn't write its Claude hook script.";
  }
}

/** Idempotent : on retire d'abord nos entrées, on les repose ensuite. Relancer
 *  l'installation répare donc « partial » et « stale » sans rien dupliquer. */
export function installHooks(): ClaudeInstallResult {
  const paths = claudePaths();
  if (!existsSync(paths.configDir)) {
    return {
      ok: false,
      state: "no-claude",
      problem: "Claude Code isn't installed — no ~/.claude directory.",
    };
  }

  // Le script d'abord : des hooks qui pointent vers un fichier absent feraient
  // afficher une erreur à chaque tour. Le garde `[ -x ]` couvre le cas, mais
  // autant ne pas s'y fier pour une installation qu'on maîtrise.
  const staged = stageScript(paths);
  if (staged) return { ok: false, state: "absent", problem: staged };

  const read = readSettings(paths.settings);
  if (!read.ok) return { ok: false, state: "unreadable", problem: read.problem };

  // Une seule fois, et seulement s'il y avait quelque chose à sauver.
  if (read.existed && !existsSync(paths.backup)) {
    try {
      copyFileSync(paths.settings, paths.backup);
    } catch {
      /* décoratif : une sauvegarde ratée n'empêche pas l'installation */
    }
  }

  const data = read.data;
  stripOurs(data);
  addOurs(data, paths.hookScript);
  if (!writeSettings(paths.settings, data, read.stamp)) {
    return {
      ok: false,
      state: "absent",
      problem: "Sunflower couldn't write Claude's settings — try again.",
    };
  }

  // Relecture : on ne réessaie pas en boucle, on le dit.
  const after = hookInstallState();
  if (after.state !== "installed") {
    return {
      ok: false,
      state: after.state,
      problem:
        after.problem ??
        "Claude's settings changed while Sunflower was writing — try again.",
    };
  }
  return { ok: true, state: "installed" };
}

/** Retire nos hooks, notre script et notre spool. Le fichier de Claude doit
 *  redevenir exactement ce qu'il était. */
export function uninstallHooks(): ClaudeInstallResult {
  const paths = claudePaths();
  const read = readSettings(paths.settings);
  if (!read.ok) return { ok: false, state: "unreadable", problem: read.problem };

  if (countOurs(read.data)) {
    const data = read.data;
    stripOurs(data);
    if (!writeSettings(paths.settings, data, read.stamp)) {
      return {
        ok: false,
        state: "partial",
        problem: "Sunflower couldn't write Claude's settings — try again.",
      };
    }
  }
  try {
    rmSync(paths.spool, { recursive: true, force: true });
    rmSync(paths.hookScript, { force: true });
  } catch {
    /* décoratif : le spool est borné, un reste ne gêne personne */
  }
  return { ok: true, state: "absent" };
}
