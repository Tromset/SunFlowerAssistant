// Sunflower-Code — la boîte à outils, portée depuis Ollama-Code : sept outils,
// tous confinés à UN dossier de travail. Aucun d'eux ne peut lire ni écrire en
// dehors (chemin absolu ou `..` = refus), aucun n'échappe à la permission du
// moment (voir permissions.ts), et `bash` passe en plus par la liste noire
// partagée avec les agents du panneau (shell-guard.ts).
//
// Le contrat est volontairement plat : des arguments texte, un résultat texte.
// C'est ce qui permet de servir les mêmes outils aux deux dialectes qu'un
// petit modèle local sait parler — l'API `tools` native d'Ollama pour ceux qui
// la gèrent, et un protocole texte de repli pour les autres.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { blockedReason } from "../shell-guard";
import type { CodeToolName } from "../../shared/code";

// ---- Bornes -------------------------------------------------------------
/** Au-delà, un fichier lu est tronqué (le modèle n'a pas la place). */
const MAX_READ_BYTES = 60_000;
/** Fichier écrit : au-delà, c'est que le modèle est parti en boucle. */
const MAX_WRITE_BYTES = 400_000;
/** Entrées rendues par list_files. */
const MAX_LIST_ENTRIES = 400;
/** Profondeur par défaut de list_files. */
const DEFAULT_LIST_DEPTH = 3;
/** Résultats rendus par search. */
const MAX_SEARCH_HITS = 80;
/** Fichiers réellement ouverts par search (au-delà : arrêt, dit clairement). */
const MAX_SEARCH_FILES = 3000;
/** Fichier plus gros que ça : ignoré par search (binaire, bundle, lockfile). */
const MAX_SEARCH_FILE_BYTES = 1_000_000;
/** Une commande approuvée ne tourne pas plus longtemps que ça. */
const COMMAND_TIMEOUT_MS = 180_000;
/** Sortie de commande rendue au modèle. */
const MAX_COMMAND_OUTPUT = 24_000;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "vendor",
  "Pods",
]);

/** Fichiers dont le contenu ne doit jamais remonter dans un prompt. */
const SECRET_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  ".dev.vars",
]);

/** Erreur d'outil : le message part tel quel au modèle ET à l'affichage. */
export class ToolError extends Error {}

// ---- Sécurité chemins ----------------------------------------------------
/** Résout un chemin relatif DANS le dossier de travail ; jette s'il s'en
 *  échappe (`..`, chemin absolu, lien qui sort). Même garde-fou que le runner
 *  d'agents et qu'Ollama-Code. */
export function resolveInside(workdir: string, rel: string): string {
  const cleaned = String(rel ?? "").trim().replace(/^\.\//, "");
  if (!cleaned) throw new ToolError("path is required.");
  if (path.isAbsolute(cleaned)) {
    throw new ToolError(`refused: "${cleaned}" is an absolute path.`);
  }
  const root = path.resolve(workdir);
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolError(`refused: "${cleaned}" escapes the project folder.`);
  }
  if (SECRET_FILES.has(path.basename(abs))) {
    throw new ToolError(`refused: "${cleaned}" may hold secrets.`);
  }
  return abs;
}

function rel(workdir: string, abs: string): string {
  const r = path.relative(path.resolve(workdir), abs);
  return r === "" ? "." : r;
}

// ---- Contexte d'exécution -------------------------------------------------
export interface CodeToolContext {
  workdir: string;
  signal: AbortSignal;
  /** Sortie streamée d'une commande (pseudo-terminal du CLI). */
  onOutput?(text: string): void;
  /** Un fichier vient d'être écrit. `before` vaut null pour une création.
   *  Seuls write_file et edit_file le signalent ; le contrat de run() ne
   *  bouge pas, l'app en tire un diff et le CLI l'ignore. */
  onChange?(relPath: string, before: string | null, after: string): void;
}

export interface CodeToolDef {
  name: CodeToolName;
  /** Description envoyée au modèle (schéma natif Ollama et protocole texte). */
  description: string;
  /** Propriétés JSON Schema des arguments. */
  properties: Record<string, { type: "string"; description: string }>;
  required: string[];
  /** Ligne courte affichée au CLI : `read_file src/main.ts`. */
  display(args: Record<string, string>): string;
  run(args: Record<string, string>, ctx: CodeToolContext): Promise<string>;
}

const arg = (args: Record<string, string>, key: string): string =>
  typeof args[key] === "string" ? args[key] : "";

const requireArg = (args: Record<string, string>, key: string): string => {
  const v = arg(args, key).trim();
  if (!v) throw new ToolError(`${key} is required.`);
  return v;
};

const shorten = (s: string, n = 48): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

// ---- Les sept outils ------------------------------------------------------

const readFile: CodeToolDef = {
  name: "read_file",
  description:
    "Read a text file inside the project folder. Optional start/end are 1-based line numbers.",
  properties: {
    path: { type: "string", description: "path relative to the project folder" },
    start: { type: "string", description: "first line to read (1-based, optional)" },
    end: { type: "string", description: "last line to read (optional)" },
  },
  required: ["path"],
  display: (a) => `read_file ${shorten(arg(a, "path"))}`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.workdir, requireArg(args, "path"));
    if (!existsSync(abs)) throw new ToolError("file not found.");
    if (statSync(abs).isDirectory()) {
      throw new ToolError("that is a folder — use list_files.");
    }
    let content = readFileSync(abs, "utf8");
    let note = "";
    const start = Number.parseInt(arg(args, "start"), 10);
    const end = Number.parseInt(arg(args, "end"), 10);
    if (Number.isFinite(start) || Number.isFinite(end)) {
      const lines = content.split("\n");
      const from = Math.max(1, Number.isFinite(start) ? start : 1);
      const to = Math.min(lines.length, Number.isFinite(end) ? end : lines.length);
      content = lines
        .slice(from - 1, to)
        .map((line, i) => `${from + i}\t${line}`)
        .join("\n");
      note = `\n[lines ${from}-${to} of ${lines.length}]`;
    }
    if (content.length > MAX_READ_BYTES) {
      content = content.slice(0, MAX_READ_BYTES);
      note = "\n[...truncated...]";
    }
    return `${content}${note}`;
  },
};

const writeFile: CodeToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file inside the project folder with the exact content given.",
  properties: {
    path: { type: "string", description: "path relative to the project folder" },
    content: { type: "string", description: "the complete new file content" },
  },
  required: ["path", "content"],
  display: (a) =>
    `write_file ${shorten(arg(a, "path"))} (${arg(a, "content").length} bytes)`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.workdir, requireArg(args, "path"));
    const content = arg(args, "content");
    if (content.length > MAX_WRITE_BYTES) {
      throw new ToolError(`refused: ${content.length} bytes is too much for one file.`);
    }
    const existed = existsSync(abs);
    // Relu AVANT d'écrire : c'est la seule fenêtre où l'ancien contenu existe
    // encore, et c'est ce qui permet à l'app de montrer un vrai diff.
    const before = existed ? readFileSync(abs, "utf8") : null;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    ctx.onChange?.(rel(ctx.workdir, abs), before, content);
    return `${existed ? "overwrote" : "created"} ${rel(ctx.workdir, abs)} (${content.length} bytes)`;
  },
};

const editFile: CodeToolDef = {
  name: "edit_file",
  description:
    "Replace one exact snippet in a file. The old text must appear exactly once — include enough context to make it unique.",
  properties: {
    path: { type: "string", description: "path relative to the project folder" },
    old: { type: "string", description: "the exact text to replace" },
    new: { type: "string", description: "the replacement text" },
  },
  required: ["path", "old", "new"],
  display: (a) => `edit_file ${shorten(arg(a, "path"))}`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.workdir, requireArg(args, "path"));
    if (!existsSync(abs)) throw new ToolError("file not found.");
    const before = readFileSync(abs, "utf8");
    const oldText = arg(args, "old");
    const newText = arg(args, "new");
    if (!oldText) throw new ToolError("old is required — use write_file to create a file.");
    const first = before.indexOf(oldText);
    if (first === -1) {
      throw new ToolError("old text not found — read the file again and copy it exactly.");
    }
    if (before.indexOf(oldText, first + 1) !== -1) {
      throw new ToolError("old text appears more than once — add surrounding lines.");
    }
    const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
    writeFileSync(abs, after);
    ctx.onChange?.(rel(ctx.workdir, abs), before, after);
    const delta = after.split("\n").length - before.split("\n").length;
    return `edited ${rel(ctx.workdir, abs)} (${delta >= 0 ? "+" : ""}${delta} lines)`;
  },
};

const moveFile: CodeToolDef = {
  name: "move_file",
  description: "Move or rename a file inside the project folder.",
  properties: {
    from: { type: "string", description: "current path, relative to the project folder" },
    to: { type: "string", description: "new path, relative to the project folder" },
  },
  required: ["from", "to"],
  display: (a) => `move_file ${shorten(arg(a, "from"), 24)} → ${shorten(arg(a, "to"), 24)}`,
  async run(args, ctx) {
    const from = resolveInside(ctx.workdir, requireArg(args, "from"));
    const to = resolveInside(ctx.workdir, requireArg(args, "to"));
    if (!existsSync(from)) throw new ToolError("source not found.");
    if (existsSync(to)) throw new ToolError("destination already exists.");
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    return `moved ${rel(ctx.workdir, from)} → ${rel(ctx.workdir, to)}`;
  },
};

/** Arborescence bornée, dossiers de build ignorés. */
function walkTree(root: string, dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_LIST_ENTRIES || depth < 0) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_LIST_ENTRIES) return;
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const r = path.relative(root, abs);
    if (st.isDirectory()) {
      out.push(`${r}/`);
      walkTree(root, abs, depth - 1, out);
    } else {
      out.push(r);
    }
  }
}

const listFiles: CodeToolDef = {
  name: "list_files",
  description:
    "List files and folders inside the project folder. Optional path narrows it, optional depth defaults to 3.",
  properties: {
    path: { type: "string", description: "subfolder to list (optional, defaults to the root)" },
    depth: { type: "string", description: "how deep to recurse (optional, default 3)" },
  },
  required: [],
  display: (a) => `list_files ${shorten(arg(a, "path") || ".")}`,
  async run(args, ctx) {
    const sub = arg(args, "path").trim();
    const abs = sub ? resolveInside(ctx.workdir, sub) : path.resolve(ctx.workdir);
    if (!existsSync(abs)) throw new ToolError("folder not found.");
    if (!statSync(abs).isDirectory()) throw new ToolError("that is a file — use read_file.");
    const parsed = Number.parseInt(arg(args, "depth"), 10);
    const depth = Number.isFinite(parsed)
      ? Math.min(8, Math.max(0, parsed))
      : DEFAULT_LIST_DEPTH;
    const out: string[] = [];
    walkTree(path.resolve(ctx.workdir), abs, depth, out);
    if (out.length === 0) return "(empty)";
    const capped = out.length >= MAX_LIST_ENTRIES ? "\n[...more entries...]" : "";
    return out.join("\n") + capped;
  },
};

const search: CodeToolDef = {
  name: "search",
  description:
    "Search the project folder for a regular expression. Returns matching lines with their file and line number.",
  properties: {
    query: { type: "string", description: "the regular expression to look for" },
    path: { type: "string", description: "subfolder to search (optional)" },
    ext: { type: "string", description: "only files with this extension, e.g. ts (optional)" },
  },
  required: ["query"],
  display: (a) => `search /${shorten(arg(a, "query"), 32)}/`,
  async run(args, ctx) {
    const query = requireArg(args, "query");
    let re: RegExp;
    try {
      re = new RegExp(query, "i");
    } catch {
      throw new ToolError("that is not a valid regular expression.");
    }
    const sub = arg(args, "path").trim();
    const root = sub ? resolveInside(ctx.workdir, sub) : path.resolve(ctx.workdir);
    if (!existsSync(root)) throw new ToolError("folder not found.");
    const wantExt = arg(args, "ext").trim().replace(/^\./, "").toLowerCase();
    const hits: string[] = [];
    let scanned = 0;
    let stopped = false;
    const visit = (dir: string) => {
      if (stopped || hits.length >= MAX_SEARCH_HITS) return;
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (stopped || hits.length >= MAX_SEARCH_HITS) return;
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        const abs = path.join(dir, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          visit(abs);
          continue;
        }
        if (wantExt && path.extname(name).slice(1).toLowerCase() !== wantExt) continue;
        if (st.size > MAX_SEARCH_FILE_BYTES) continue;
        if (++scanned > MAX_SEARCH_FILES) {
          stopped = true;
          return;
        }
        let text: string;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        // Fichier binaire déguisé en texte : un NUL suffit à le dire.
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= MAX_SEARCH_HITS) break;
          const line = lines[i] ?? "";
          if (re.test(line)) {
            hits.push(
              `${rel(ctx.workdir, abs)}:${i + 1}: ${line.trim().slice(0, 200)}`,
            );
          }
        }
      }
    };
    if (statSync(root).isDirectory()) visit(root);
    else visit(path.dirname(root));
    if (hits.length === 0) return "no match.";
    const capped =
      hits.length >= MAX_SEARCH_HITS
        ? `\n[...stopped at ${MAX_SEARCH_HITS} matches...]`
        : stopped
          ? `\n[...stopped after ${MAX_SEARCH_FILES} files...]`
          : "";
    return hits.join("\n") + capped;
  },
};

const bash: CodeToolDef = {
  name: "bash",
  description:
    "Run one shell command with the working directory locked to the project folder. Destructive commands are refused outright.",
  properties: {
    command: { type: "string", description: "the shell command to run" },
  },
  required: ["command"],
  display: (a) => `bash ${shorten(arg(a, "command"), 60)}`,
  run(args, ctx) {
    const command = requireArg(args, "command");
    const blocked = blockedReason(command);
    if (blocked) {
      return Promise.reject(
        new ToolError(`refused outright (${blocked}) — this is never allowed.`),
      );
    }
    return new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, {
          cwd: path.resolve(ctx.workdir), // strict : jamais un autre dossier
          shell: true,
          env: process.env,
          // Groupe de processus dédié (POSIX) : le timeout tue aussi les
          // petits-enfants (npm → node → …), pas seulement le shell.
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (err) {
        reject(new ToolError(err instanceof Error ? err.message : "spawn failed"));
        return;
      }
      let output = "";
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const killTree = () => {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // déjà mort
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, COMMAND_TIMEOUT_MS);
      const onAbort = () => {
        cancelled = true;
        killTree();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const done = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(text);
      };
      const append = (buf: Buffer) => {
        const text = buf.toString("utf8");
        if (output.length < MAX_COMMAND_OUTPUT) {
          output += text.slice(0, MAX_COMMAND_OUTPUT - output.length);
        }
        ctx.onOutput?.(text);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (err) => done(`failed to start: ${err.message}`));
      child.on("close", (code) => {
        const note = timedOut
          ? ` (killed after ${COMMAND_TIMEOUT_MS / 1000}s)`
          : cancelled
            ? " (cancelled)"
            : "";
        const body = output.trim() || "(no output)";
        const capped =
          output.length >= MAX_COMMAND_OUTPUT ? "\n[...output truncated...]" : "";
        done(`exit ${code ?? "?"}${note}\n${body}${capped}`);
      });
    });
  },
};

export const TOOLS: Record<CodeToolName, CodeToolDef> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  move_file: moveFile,
  list_files: listFiles,
  search,
  bash,
};

/** Schémas au format `tools` d'Ollama, pour les modèles qui savent s'en servir. */
export function ollamaToolSpecs(names: readonly CodeToolName[]): unknown[] {
  return names.map((name) => {
    const def = TOOLS[name];
    return {
      type: "function",
      function: {
        name: def.name,
        description: def.description,
        parameters: {
          type: "object",
          properties: def.properties,
          required: def.required,
        },
      },
    };
  });
}

/** Même contrat, mais en texte : le repli pour les modèles sans function-calling. */
export function toolProtocolHelp(names: readonly CodeToolName[]): string {
  return names
    .map((name) => {
      const def = TOOLS[name];
      const params = Object.entries(def.properties)
        .map(([key, spec]) =>
          `${key}${def.required.includes(key) ? "" : "?"}: ${spec.description}`,
        )
        .join("; ");
      return `- ${def.name} — ${def.description}\n  args: ${params || "(none)"}`;
    })
    .join("\n");
}
