#!/usr/bin/env node
// `sunflower requirements` — la requirements.txt du projet global. Lit le
// fichier requirements.txt à la racine du repo (lignes « # nom: valeur »),
// vérifie chaque exigence (node, pnpm, dépendances, build, Ollama, modèles)
// et, avec --fix, installe lui-même ce qui peut l'être : pnpm install, build
// esbuild, pull du modèle Ollama. Zéro dépendance (Node ≥ 18, fetch global),
// CJS comme bin/sunflower.js, esthétique tournesol alignée sur
// sunflower-models.js : mêmes couleurs ANSI, même bannière ✿.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Client Ollama partagé (voir lib/ollama-api.cjs) : une seule implémentation
// de l'hôte et de /api/tags pour l'app et les deux bins.
const api = require("../lib/ollama-api.cjs");

// ---- Couleurs (calquées sur tui.ts) ----------------------------------
const fancy =
  process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const paint = (code) => (s) => (fancy ? `\x1b[${code}m${s}\x1b[0m` : s);
const yellow = paint("33");
const green = paint("32");
const red = paint("31");
const dim = paint("2");
const bold = paint("1");

// ---- Config de l'app (miroir de config-store.ts / config-schema.ts) --
const DEFAULT_MODEL = "qwen3-vl:8b";
const DEFAULT_HOST = "http://127.0.0.1:11434";
const DEFAULT_WHISPER = "ggml-small-q5_1.bin";

/** Répertoire userData d'Electron pour l'app « sunflower », par plateforme. */
function userDataDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "sunflower");
  }
  if (process.platform === "win32") {
    const appData =
      process.env["APPDATA"] || path.join(home, "AppData", "Roaming");
    return path.join(appData, "sunflower");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.trim() ? xdg : path.join(home, ".config");
  return path.join(base, "sunflower");
}

/** Config lue ; objet vide si absente ou illisible (lecture seule ici). */
function readConfig() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(userDataDir(), "config.json"), "utf8"),
    );
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* absente ou corrompue : les défauts suffisent pour vérifier */
  }
  return {};
}

function activeModel() {
  const cfg = readConfig();
  return typeof cfg.ollamaModel === "string" && cfg.ollamaModel
    ? cfg.ollamaModel
    : DEFAULT_MODEL;
}

function whisperModelFile() {
  const cfg = readConfig();
  return typeof cfg.whisperModel === "string" && cfg.whisperModel
    ? cfg.whisperModel
    : DEFAULT_WHISPER;
}

/** Hôte Ollama : OLLAMA_HOST > config > défaut ; préfixe http, sans slash final. */
function ollamaHost() {
  const cfg = readConfig();
  return api.normalizeHost(
    process.env["OLLAMA_HOST"] ||
      (typeof cfg.ollamaHost === "string" && cfg.ollamaHost) ||
      DEFAULT_HOST,
  );
}

// ---- Racines du projet ------------------------------------------------
const appRoot = path.resolve(__dirname, "..");

/** Racine du projet global : le dossier portant pnpm-workspace.yaml en
 *  remontant depuis apps/electron ; sinon apps/electron lui-même. */
function workspaceRoot() {
  let dir = appRoot;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return appRoot;
}

// ---- requirements.txt --------------------------------------------------
// Format : chaque ligne est un commentaire (un `pip install -r` égaré
// n'installe donc rien) ; les entrées machine sont les lignes « # nom: valeur »
// (un seul #). Les lignes « ## … » sont de la prose.
const ENTRY_RE = /^#\s*([a-z0-9-]+)\s*:\s*(.+?)\s*$/;

/** Entrées par défaut — identiques au requirements.txt commité, pour que la
 *  commande marche même depuis un checkout qui ne l'a pas encore. */
const DEFAULT_ENTRIES = [
  ["node", ">=18"],
  ["pnpm", "any"],
  ["node-deps", "installed"],
  ["build", "auto"],
  ["ollama", "reachable"],
  ["ollama-model", "vision"],
  ["whisper-model", "auto"],
  ["elevenlabs-api-key", "optional"],
  ["anthropic-api-key", "optional"],
  ["wispr-flow-api-key", "optional"],
];

function loadRequirements() {
  const file = path.join(workspaceRoot(), "requirements.txt");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { entries: DEFAULT_ENTRIES, source: null };
  }
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("##")) continue;
    const m = ENTRY_RE.exec(line);
    if (m) entries.push([m[1].toLowerCase(), m[2]]);
  }
  return { entries: entries.length > 0 ? entries : DEFAULT_ENTRIES, source: file };
}

// ---- Vérifications -----------------------------------------------------
// Chaque check retourne { status, detail, fix?, autofix? } :
//   status  "ok" | "fail" | "soft" (manquant mais non bloquant) | "skip"
//   fix     phrase courte affichée sous la ligne quand ça manque
//   autofix fonction async lancée par --fix (réparations dans l'ordre du fichier)

function checkNode(spec) {
  const version = process.versions.node;
  const m = /^>=\s*(\d+)(?:\.(\d+))?/.exec(spec);
  if (!m) return { status: "ok", detail: `v${version}` };
  const [maj = 0, min = 0] = version.split(".").map(Number);
  const wantMaj = Number(m[1]);
  const wantMin = m[2] ? Number(m[2]) : 0;
  const ok = maj > wantMaj || (maj === wantMaj && min >= wantMin);
  return ok
    ? { status: "ok", detail: `v${version} (needs ${spec})` }
    : {
        status: "fail",
        detail: `v${version} is too old (needs ${spec})`,
        fix: "install a newer Node from nodejs.org (or: nvm install --lts)",
      };
}

function pnpmVersion() {
  const r = spawnSync("pnpm", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.error || r.status !== 0) return null;
  const v = String(r.stdout ?? "").trim();
  return v || null;
}

function checkPnpm() {
  const v = pnpmVersion();
  return v
    ? { status: "ok", detail: v }
    : {
        status: "fail",
        detail: "not on PATH",
        fix: "corepack enable   (Node ships it) — or: npm install -g pnpm",
      };
}

function electronResolvable() {
  try {
    require.resolve("electron", { paths: [appRoot] });
    return true;
  } catch {
    return false;
  }
}

function runPnpmInstall() {
  process.stdout.write(
    `\n${yellow("↻")} installing dependencies ${dim(`(pnpm install in ${workspaceRoot()})`)}\n`,
  );
  const r = spawnSync("pnpm", ["install"], {
    cwd: workspaceRoot(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return !r.error && r.status === 0;
}

function checkNodeDeps() {
  if (electronResolvable()) {
    return { status: "ok", detail: "node_modules present (electron resolves)" };
  }
  return {
    status: "fail",
    detail: "node_modules missing",
    fix: pnpmVersion()
      ? "pnpm install at the repo root — or: sunflower requirements --fix"
      : "install pnpm first, then pnpm install at the repo root",
    autofix: () => {
      if (!pnpmVersion()) return false;
      return runPnpmInstall();
    },
  };
}

function checkBuild() {
  if (fs.existsSync(path.join(appRoot, "dist", ".build-ok"))) {
    return { status: "ok", detail: "dist/ is built" };
  }
  // Non bloquant : bin/sunflower.js reconstruit lui-même au lancement.
  return {
    status: "soft",
    detail: "not built yet — sunflower builds it automatically on launch",
    autofix: () => {
      if (!electronResolvable()) return false;
      process.stdout.write(`\n${yellow("↻")} building ${dim("(node scripts/build.mjs)")}\n`);
      const r = spawnSync(
        process.execPath,
        [path.join(appRoot, "scripts", "build.mjs")],
        { cwd: appRoot, stdio: "inherit" },
      );
      return !r.error && r.status === 0;
    },
  };
}

/** Ollama joignable ? Retourne { reachable, models } sans jamais jeter. */
async function tags() {
  try {
    return { reachable: true, models: await api.listModels(ollamaHost(), 3000) };
  } catch {
    return { reachable: false, models: [] };
  }
}

function checkOllamaReachable(state) {
  return state.reachable
    ? {
        status: "ok",
        detail: `${ollamaHost()} · ${state.models.length} model${state.models.length === 1 ? "" : "s"}`,
      }
    : {
        status: "fail",
        detail: `can't reach ${ollamaHost()}`,
        fix: "start it: ollama serve",
      };
}

/** « qwen3-vl:8b » == « qwen3-vl:8b:latest » ? Normalise le tag manquant. */
const sameModel = api.sameModel;

// Même heuristique de secours que sunflower-models.js pour les vieux Ollama
// dont /api/tags ne remonte pas encore `capabilities`.
const VISION_RE = /(vl|vision|llava|moondream|minicpm-v|bakllava|mllama)/i;

function checkOllamaModel(spec, state) {
  if (!state.reachable) {
    return { status: "skip", detail: "skipped — ollama unreachable" };
  }
  const wanted = spec === "vision" ? activeModel() : spec;
  if (state.models.some((m) => sameModel(m.name, wanted))) {
    return { status: "ok", detail: `${wanted} is pulled` };
  }
  if (spec === "vision") {
    // Miroir de src/main/ollama.ts : à défaut du modèle configuré, l'app
    // prend le premier modèle local avec la capacité vision.
    const fallback = state.models.find(
      (m) =>
        (Array.isArray(m.capabilities) && m.capabilities.includes("vision")) ||
        VISION_RE.test(String(m.name)),
    );
    if (fallback) {
      return {
        status: "ok",
        detail: `${wanted} not pulled — sunflower will use ${fallback.name} (vision)`,
      };
    }
  }
  return {
    status: "fail",
    detail:
      spec === "vision"
        ? `no vision-capable model at ${ollamaHost()}`
        : `${wanted} is not pulled`,
    fix: `sunflower models --pull ${wanted}`,
    autofix: () => {
      const r = spawnSync(
        process.execPath,
        [path.join(__dirname, "sunflower-models.js"), "--pull", wanted],
        { stdio: "inherit" },
      );
      return !r.error && r.status === 0;
    },
  };
}

function fmtBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/** Entrée « nom: optional » (clés API cloud…) : vérification douce de la
 *  variable d'environnement NOM_EN_MAJUSCULES — jamais bloquante, ces clés
 *  adoucissent l'expérience mais cassent le « 100 % local ». */
function checkOptional(name) {
  const envVar = name.toUpperCase().replace(/-/g, "_");
  const set =
    typeof process.env[envVar] === "string" && process.env[envVar].trim() !== "";
  return set
    ? { status: "ok", detail: `set (env ${envVar})` }
    : { status: "soft", detail: `not set — optional (env ${envVar})` };
}

function checkWhisperModel(spec) {
  const file = spec === "auto" ? whisperModelFile() : spec;
  const abs = path.join(userDataDir(), "models", file);
  try {
    const st = fs.statSync(abs);
    return { status: "ok", detail: `${file} (${fmtBytes(st.size)})` };
  } catch {
    // Non bloquant : l'app le télécharge d'elle-même au premier lancement.
    return {
      status: "soft",
      detail: `${file} downloads on first launch (~190 MB)`,
    };
  }
}

async function runChecks(entries) {
  const state = await tags();
  const results = [];
  for (const [name, spec] of entries) {
    let r;
    if (spec === "optional") r = checkOptional(name);
    else if (name === "node") r = checkNode(spec);
    else if (name === "pnpm") r = checkPnpm();
    else if (name === "node-deps") r = checkNodeDeps();
    else if (name === "build") r = checkBuild();
    else if (name === "ollama") r = checkOllamaReachable(state);
    else if (name === "ollama-model") r = checkOllamaModel(spec, state);
    else if (name === "whisper-model") r = checkWhisperModel(spec);
    else r = { status: "skip", detail: `unknown requirement — ignored` };
    results.push({ name, ...r });
  }
  return results;
}

// ---- Rendu -------------------------------------------------------------
function bannerLines() {
  if (!fancy) return ["sunflower requirements — check what the global project needs"];
  return [
    yellow("   \\ | /"),
    `${yellow("  ── (")}${bold(yellow("✿"))}${yellow(") ──")}   ${bold("sunflower requirements")}`,
    `${yellow("   / | \\")}     ${dim("check what the global project needs")}`,
    green("     |"),
  ];
}

const MARKS = {
  ok: () => green("✓"),
  fail: () => red("✗"),
  soft: () => dim("○"),
  skip: () => dim("–"),
};

function render(results, source) {
  const out = [""];
  out.push(...bannerLines());
  out.push("");
  out.push(
    source
      ? dim(`  ${source}`)
      : dim("  requirements.txt not found — using built-in defaults"),
  );
  out.push("");
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    out.push(`  ${MARKS[r.status]()} ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.status === "fail" && r.fix) {
      out.push(`${" ".repeat(width + 6)}${dim(`↳ fix: `)}${yellow(r.fix)}`);
    }
  }
  out.push("");
  const missing = results.filter((r) => r.status === "fail");
  if (missing.length === 0) {
    out.push(`  ${green("✓")} all requirements satisfied — sunflower is good to go`);
  } else {
    out.push(
      `  ${red("✗")} ${missing.length} requirement${missing.length === 1 ? "" : "s"} missing`,
    );
    if (missing.some((r) => r.autofix)) {
      out.push(
        `    ${dim("install what can be installed automatically:")} ${yellow("sunflower requirements --fix")}`,
      );
    }
  }
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
}

// ---- --help ------------------------------------------------------------
function printHelp() {
  const lines = [
    "",
    ...bannerLines(),
    "",
    `${bold("USAGE")}`,
    `  ${yellow("sunflower requirements")}           check every line of requirements.txt`,
    `  ${yellow("sunflower requirements --fix")}     also install what it can (pnpm install,`,
    `                                   the Electron build, the Ollama model)`,
    `  ${yellow("sunflower requirements --help")}    show this help`,
    "",
    `  Also runnable directly as ${yellow("sunflower-requirements")}.`,
    "",
    `  The manifest lives at the repo root: ${dim(path.join(workspaceRoot(), "requirements.txt"))}`,
    `  Every line in it is a comment on purpose — a stray ${dim("pip install -r")} installs nothing.`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// ---- Dispatch ----------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  const fix = args.includes("--fix");
  const unknown = args.find((a) => a !== "--fix");
  if (unknown) {
    process.stderr.write(`${red("✗")} unknown option: ${unknown}\n`);
    printHelp();
    return 1;
  }

  const { entries, source } = loadRequirements();
  let results = await runChecks(entries);

  const fixable = () =>
    results.filter((r) => (r.status === "fail" || r.status === "soft") && r.autofix);
  if (fix && fixable().length > 0) {
    // Réparations dans l'ordre du fichier (deps avant build avant modèle) ;
    // chaque autofix revérifie ses propres prérequis au moment de tourner.
    for (const r of fixable()) {
      await r.autofix();
    }
    results = await runChecks(entries); // re-vérification après réparation
  }

  render(results, source);
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`${red("✗")} ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
