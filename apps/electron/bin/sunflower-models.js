#!/usr/bin/env node
// `sunflower-models` — parcourir les modèles locaux et en télécharger depuis
// Ollama, puis choisir celui que sunflower utilise. Zéro dépendance (Node ≥ 18,
// fetch global), CJS comme bin/sunflower.js. Esthétique tournesol noir/jaune
// alignée sur src/main/tui.ts : mêmes couleurs ANSI, même bannière ✿, même
// spinner braille. Écrit le champ `ollamaModel` dans le config.json de l'app
// (même emplacement/forme que src/main/config-store.ts) en préservant les
// champs inconnus.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---- Couleurs (calquées sur tui.ts) ----------------------------------
const fancy =
  process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const paint = (code) => (s) => (fancy ? `\x1b[${code}m${s}\x1b[0m` : s);
const yellow = paint("33");
const green = paint("32");
const red = paint("31");
const cyan = paint("36");
const dim = paint("2");
const bold = paint("1");

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[2K";

// Client Ollama partagé avec l'app et l'autre bin — une seule implémentation
// de l'hôte, de /api/tags et du pull (voir lib/ollama-api.cjs).
const api = require("../lib/ollama-api.cjs");

// ---- Config de l'app (miroir de config-store.ts / config-schema.ts) --
const DEFAULT_MODEL = "qwen3-vl:8b";
const DEFAULT_HOST = "http://127.0.0.1:11434";

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
  // linux & autres : $XDG_CONFIG_HOME/sunflower, sinon ~/.config/sunflower
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.trim() ? xdg : path.join(home, ".config");
  return path.join(base, "sunflower");
}

function configPath() {
  return path.join(userDataDir(), "config.json");
}

/** Lit le config.json ; objet vide si absent/illisible (champs inconnus gardés). */
/** Config lue ; `null` si le fichier EXISTE mais est illisible/corrompu —
 *  dans ce cas on refuse d'écrire par-dessus (on effacerait ses champs). */
function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), "utf8");
  } catch {
    return {}; // absent : on partira d'un fichier neuf
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // illisible : surtout ne pas le remplacer silencieusement
  }
  return null;
}

/** Écrit `ollamaModel` sans toucher aux autres champs (écriture atomique).
 *  Retourne false (sans écrire) si le config existant est corrompu. */
function setActiveModel(model) {
  const cfg = readConfig();
  if (cfg === null) {
    process.stderr.write(
      `${red("✗")} ${configPath()} exists but isn't valid JSON — fix or delete it first (nothing was written).\n`,
    );
    return false;
  }
  cfg.ollamaModel = model;
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  return true;
}

function activeModel() {
  const cfg = readConfig() ?? {};
  return typeof cfg.ollamaModel === "string" && cfg.ollamaModel
    ? cfg.ollamaModel
    : DEFAULT_MODEL;
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

// ---- Catalogue recommandé --------------------------------------------
// L'app a besoin de modèles VISION pour les questions sur l'écran, et de
// modèles texte pour le harnais de code. Tailles ≈ (poids Ollama).
const CATALOG = [
  // Vision
  { name: "qwen3-vl:8b", vision: true, size: "6.6 GB", note: "app default" },
  { name: "qwen2.5vl:3b", vision: true, size: "3.2 GB", note: "small, fast" },
  { name: "qwen2.5vl:7b", vision: true, size: "6.0 GB", note: "sharper" },
  { name: "llama3.2-vision:11b", vision: true, size: "7.8 GB", note: "large" },
  { name: "moondream", vision: true, size: "1.7 GB", note: "tiny" },
  { name: "llava:7b", vision: true, size: "4.7 GB", note: "" },
  { name: "llava:13b", vision: true, size: "8.0 GB", note: "" },
  { name: "minicpm-v", vision: true, size: "5.5 GB", note: "" },
  // Texte (harnais de code)
  { name: "qwen2.5-coder:7b", vision: false, size: "4.7 GB", note: "coding" },
  { name: "llama3.1:8b", vision: false, size: "4.9 GB", note: "general" },
  { name: "deepseek-r1:7b", vision: false, size: "4.7 GB", note: "reasoning" },
  { name: "deepseek-r1:8b", vision: false, size: "5.2 GB", note: "reasoning" },
];

const VISION_RE = /(vl|vision|llava|moondream|minicpm-v|bakllava|mllama)/i;
const sameModel = api.sameModel;

function isVisionName(name) {
  const n = String(name).toLowerCase();
  return CATALOG.some((c) => c.vision && sameModel(c.name, name)) ||
    VISION_RE.test(n);
}

// ---- Utilitaires réseau ----------------------------------------------
/** Ollama joignable mais réseau KO (refus de connexion, DNS, timeout…). */
class Unreachable extends Error {}

async function apiTags() {
  const host = ollamaHost();
  try {
    return await api.listModels(host, 3000);
  } catch (err) {
    // Un hôte qui répond mal et un hôte absent ne se soignent pas pareil :
    // le premier mérite son message, le second le mode d'emploi complet.
    if (err && /HTTP \d+/.test(String(err.message))) {
      throw new Error(`ollama responded badly at ${host}`);
    }
    throw new Unreachable(host);
  }
}

function fmtBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function ollamaDownHint(host) {
  const h = host || ollamaHost();
  process.stderr.write(
    "\n" +
      `${red("✗")} Can't reach Ollama at ${bold(h)}\n` +
      "  Ollama doesn't seem to be running. Start it with:\n\n" +
      `      ${yellow("ollama serve")}\n\n` +
      "  Then run this command again.\n",
  );
}

// ---- --help -----------------------------------------------------------
function printHelp() {
  const lines = [
    "",
    ...bannerLines(),
    "",
    `${bold("USAGE")}`,
    `  ${yellow("sunflower models")}                 interactive browser (installed + recommended)`,
    `  ${yellow("sunflower models --list")}          plain list of installed & recommended models`,
    `  ${yellow("sunflower models --pull")} ${dim("<model>")}  download a model from Ollama with a progress bar`,
    `  ${yellow("sunflower models --use")} ${dim("<model>")}   set the model sunflower uses`,
    `  ${yellow("sunflower models --help")}          show this help`,
    "",
    `  Also runnable directly as ${yellow("sunflower-models")}.`,
    "",
    `  In the interactive browser: ${dim("↑/↓ move · enter select/download · q quit")}`,
    `  Enter on an ${green("installed")} model makes it active; on a new one it downloads it.`,
    "",
    `  Active model is stored in ${dim(configPath())}`,
    `  Requires Ollama running locally ${dim("(ollama serve)")}.`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function bannerLines() {
  if (!fancy) return ["sunflower models — browse & download local models"];
  return [
    yellow("   \\ | /"),
    `${yellow("  ── (")}${bold(yellow("✿"))}${yellow(") ──")}   ${bold("sunflower models")}`,
    `${yellow("   / | \\")}     ${dim("browse & download local models")}`,
    green("     |"),
  ];
}

// ---- --list -----------------------------------------------------------
async function runList() {
  let installed;
  try {
    installed = await apiTags();
  } catch (err) {
    if (err instanceof Unreachable) {
      ollamaDownHint(err.message);
    } else {
      process.stderr.write(`${red("✗")} ${err.message}\n`);
    }
    return 1;
  }

  const active = activeModel();
  const installedNames = new Set(installed.map((m) => m.name));

  const out = [];
  out.push(`Installed models  ${dim(`(${ollamaHost()})`)}`);
  if (installed.length === 0) {
    out.push("  (none yet — pick one from Recommended below)");
  } else {
    const rows = installed.map((m) => [
      sameModel(m.name, active) ? `* ${m.name}` : `  ${m.name}`,
      fmtBytes(m.sizeBytes) || "-",
      (m.details && m.details.parameter_size) || "-",
      isVisionName(m.name) ? "vision" : "text",
    ]);
    out.push(table(["MODEL", "SIZE", "PARAMS", "KIND"], rows));
  }

  out.push("");
  out.push("Recommended");
  const recRows = CATALOG.map((c) => [
    `  ${c.name}`,
    c.size,
    c.vision ? "vision" : "text",
    installedNames.has(c.name) || [...installedNames].some((n) => sameModel(n, c.name))
      ? "installed"
      : c.note || "",
  ]);
  out.push(table(["MODEL", "SIZE", "KIND", "NOTE"], recRows));
  out.push("");
  out.push(dim("* = active model"));

  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

/** Table texte à colonnes alignées (largeurs calculées sur le texte brut). */
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const fmtRow = (cells, color) =>
    (
      "  " +
      cells
        .map((c, i) => {
          const padded = String(c ?? "").padEnd(widths[i]);
          return color ? color(padded) : padded;
        })
        .join("  ")
    ).replace(/\s+$/, "");
  return [fmtRow(headers, dim), ...rows.map((r) => fmtRow(r))].join("\n");
}

// ---- --use ------------------------------------------------------------
async function runUse(model) {
  if (!model) {
    process.stderr.write(`${red("✗")} usage: sunflower models --use <model>\n`);
    return 1;
  }
  if (!setActiveModel(model)) return 1;
  process.stdout.write(`${green("✓")} active model set to ${bold(model)}\n`);
  process.stdout.write(dim(`  ${configPath()}\n`));
  process.stdout.write(
    dim("  if sunflower is running, quit and relaunch it to pick this up.\n"),
  );
  // Avertissement best-effort : le modèle est-il déjà installé ? (non bloquant)
  try {
    const installed = await apiTags();
    const present = installed.some((m) => sameModel(m.name, model));
    if (!present) {
      process.stdout.write(
        dim(`  not installed yet — run: `) +
          yellow(`sunflower models --pull ${model}\n`),
      );
    }
  } catch {
    // Ollama absent : le config a quand même été écrit, on n'échoue pas.
  }
  return 0;
}

// ---- pull (téléchargement + barre de progression) --------------------
/**
 * POST /api/pull en flux NDJSON, rend une barre de progression sur une ligne.
 * Retourne { ok, unreachable }.
 */
async function pullModel(model, signal) {
  const host = ollamaHost();
  process.stdout.write(`\n${yellow("↓")} pulling ${bold(model)} …\n`);

  let status = "";
  let total = 0;
  let completed = 0;
  let spin = 0;
  let last = 0;

  const draw = (final) => {
    const frame = FRAMES[spin++ % FRAMES.length] ?? "⠋";
    const label = total > 0 ? "downloading" : status || "preparing";
    let bar = "";
    let extra = "";
    if (total > 0) {
      const pct = Math.min(1, completed / total);
      const width = 22;
      const filled = Math.round(pct * width);
      bar =
        yellow("[" + "█".repeat(filled)) +
        dim("░".repeat(width - filled)) +
        yellow("] ") +
        `${String(Math.round(pct * 100)).padStart(3)}%  `;
      extra = dim(`${fmtBytes(completed)} / ${fmtBytes(total)}`);
    }
    const head = final ? green("✓") : yellow(frame);
    process.stdout.write(
      `${CLEAR_LINE}${head} ${label.padEnd(12).slice(0, 12)} ${bar}${extra}`,
    );
    if (final) process.stdout.write("\n");
  };

  try {
    await api.pullModel(
      host,
      model,
      (progress) => {
        status = progress.status || status;
        total = progress.total;
        completed = progress.completed;
        const now = Date.now();
        if (now - last > 80) {
          draw(false);
          last = now;
        }
      },
      signal,
    );
  } catch (err) {
    if (signal && signal.aborted) {
      process.stdout.write(`${CLEAR_LINE}${dim("  cancelled.")}\n`);
      return { ok: false, unreachable: false };
    }
    // Rien n'est parti sur le réseau : Ollama n'est pas là. Une erreur en
    // cours de flux, elle, a un message d'Ollama qui mérite d'être montré.
    if (err && (err.name === "TypeError" || /fetch failed/i.test(String(err.message)))) {
      ollamaDownHint(host);
      return { ok: false, unreachable: true };
    }
    process.stdout.write(`${CLEAR_LINE}${red("✗")} ${err.message}\n`);
    return { ok: false, unreachable: false };
  }

  draw(true);
  process.stdout.write(`${green("✓")} ${bold(model)} is ready\n`);
  return { ok: true, unreachable: false };
}

// ---- --pull <model> (non interactif) ---------------------------------
async function runPull(model) {
  if (!model) {
    process.stderr.write(`${red("✗")} usage: sunflower models --pull <model>\n`);
    return 1;
  }
  const { ok, unreachable } = await pullModel(model);
  if (unreachable) return 1;
  if (!ok) return 1;
  process.stdout.write(
    dim("  make it active with: ") + yellow(`sunflower models --use ${model}\n`),
  );
  return 0;
}

// ---- Navigateur interactif -------------------------------------------
async function runInteractive() {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    // Sans TTY : pas de navigation clavier possible, on retombe sur --list.
    process.stderr.write(dim("no interactive terminal — showing a plain list\n"));
    return runList();
  }

  let installed;
  try {
    installed = await apiTags();
  } catch (err) {
    if (err instanceof Unreachable) ollamaDownHint(err.message);
    else process.stderr.write(`${red("✗")} ${err.message}\n`);
    return 1;
  }

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?25l"); // cacher le curseur

  let keyResolver = null;
  const keyQueue = [];
  let activeAbort = null;

  const onData = (buf) => {
    for (const key of decodeKeys(buf)) {
      if (key === "ctrl-c" && activeAbort) {
        activeAbort.abort();
        continue;
      }
      if (keyResolver) {
        const r = keyResolver;
        keyResolver = null;
        r(key);
      } else {
        keyQueue.push(key);
      }
    }
  };
  stdin.on("data", onData);
  const nextKey = () =>
    keyQueue.length
      ? Promise.resolve(keyQueue.shift())
      : new Promise((res) => {
          keyResolver = res;
        });

  const cleanup = () => {
    stdin.off("data", onData);
    process.stdout.write("\x1b[?25h"); // rendre le curseur
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
  };

  let cursor = 0;
  let flash = "";

  const buildRows = () => {
    const active = activeModel();
    const installedNames = installed.map((m) => m.name);
    const rows = [];
    rows.push({ type: "header", text: "Installed" });
    if (installed.length === 0) {
      rows.push({ type: "empty", text: "no models yet — pick one below to download" });
    } else {
      for (const m of installed) {
        rows.push({
          type: "model",
          name: m.name,
          size: fmtBytes(m.sizeBytes),
          params: (m.details && m.details.parameter_size) || "",
          vision: isVisionName(m.name),
          installed: true,
          active: sameModel(m.name, active),
        });
      }
    }
    rows.push({ type: "header", text: "Recommended" });
    for (const c of CATALOG) {
      const isInstalled = installedNames.some((n) => sameModel(n, c.name));
      rows.push({
        type: "model",
        name: c.name,
        size: c.size,
        params: "",
        vision: c.vision,
        note: c.note,
        installed: isInstalled,
        active: sameModel(c.name, active),
      });
    }
    return rows;
  };

  const render = (rows, selectable) => {
    const out = [];
    out.push(...bannerLines());
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.type === "header") {
        out.push("");
        out.push(bold(yellow(r.text)));
        continue;
      }
      if (r.type === "empty") {
        out.push(`     ${dim(r.text)}`);
        continue;
      }
      const selected = selectable[cursor] === i;
      const marker = selected ? yellow("❯") : " ";
      const dot = r.active ? green("●") : r.installed ? dim("○") : " ";
      const namePad = String(r.name).padEnd(22);
      const name = selected ? bold(namePad) : namePad;
      const size = r.size ? dim(String(r.size).padStart(8)) : " ".repeat(8);
      const params = r.params ? dim(String(r.params).padStart(6)) : " ".repeat(6);
      const kind = r.vision ? cyan("vision") : dim(" text ");
      const tags = [];
      if (r.active) tags.push(green("active"));
      else if (r.installed) tags.push(dim("installed"));
      else tags.push(dim("↓ download"));
      if (r.note) tags.push(dim(`· ${r.note}`));
      out.push(` ${marker} ${dot} ${name} ${size}  ${params}  ${kind}  ${tags.join(" ")}`);
    }
    out.push("");
    if (flash) out.push(`   ${flash}`);
    out.push(dim("   ↑/↓ move · enter select / download · q quit"));
    // Home + contenu + efface le reste de l'écran (évite les résidus).
    process.stdout.write("\x1b[H" + out.join("\n") + "\x1b[0J");
  };

  let exitCode = 0;
  try {
    process.stdout.write("\x1b[2J"); // premier rendu : écran propre
    for (;;) {
      const rows = buildRows();
      const selectable = [];
      rows.forEach((r, i) => {
        if (r.type === "model") selectable.push(i);
      });
      if (selectable.length === 0) break;
      if (cursor >= selectable.length) cursor = selectable.length - 1;
      if (cursor < 0) cursor = 0;
      render(rows, selectable);

      const key = await nextKey();
      if (key === "up" || key === "k") {
        cursor = (cursor - 1 + selectable.length) % selectable.length;
        flash = "";
      } else if (key === "down" || key === "j") {
        cursor = (cursor + 1) % selectable.length;
        flash = "";
      } else if (key === "q" || key === "ctrl-c" || key === "esc") {
        break;
      } else if (key === "enter") {
        const r = rows[selectable[cursor]];
        if (r.installed) {
          flash = setActiveModel(r.name)
            ? `${green("✓")} active model is now ${bold(r.name)} ${dim("(restart sunflower)")}`
            : `${red("✗")} config file is unreadable — nothing written`;
        } else {
          // Télécharger : on sort du rendu plein écran le temps du pull.
          process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
          const ctrl = new AbortController();
          activeAbort = ctrl;
          const { ok } = await pullModel(r.name, ctrl.signal);
          activeAbort = null;
          process.stdout.write("\x1b[?25l");
          if (ok) {
            process.stdout.write(
              `\n${dim("set as active model?")} ${bold("[Y/n]")} `,
            );
            const ans = await nextKey();
            process.stdout.write("\n");
            if (ans === "y" || ans === "enter") {
              flash = setActiveModel(r.name)
                ? `${green("✓")} active model is now ${bold(r.name)} ${dim("(restart sunflower)")}`
                : `${red("✗")} config file is unreadable — nothing written`;
            } else {
              flash = `${green("✓")} ${bold(r.name)} downloaded`;
            }
            // Rafraîchir la liste installée.
            try {
              installed = await apiTags();
            } catch (err) {
              if (err instanceof Unreachable) {
                ollamaDownHint(err.message);
                exitCode = 1;
                break;
              }
            }
          } else {
            flash = `${red("✗")} ${bold(r.name)} was not downloaded`;
          }
          process.stdout.write("\x1b[2J"); // repartir sur un écran propre
        }
      }
    }
  } finally {
    cleanup();
  }
  process.stdout.write("\n");
  return exitCode;
}

/** Décode un buffer clavier brut en tokens : up/down/enter/ctrl-c/esc/char. */
function decodeKeys(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\x1b") {
      const three = s.slice(i, i + 3);
      if (three === "\x1b[A" || three === "\x1bOA") {
        keys.push("up");
        i += 3;
        continue;
      }
      if (three === "\x1b[B" || three === "\x1bOB") {
        keys.push("down");
        i += 3;
        continue;
      }
      if (three === "\x1b[C" || three === "\x1b[D") {
        i += 3;
        continue; // gauche/droite ignorées
      }
      keys.push("esc");
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") keys.push("enter");
    else if (c === "\x03") keys.push("ctrl-c");
    else if (c === "\x04") keys.push("q"); // Ctrl+D quitte aussi
    else keys.push(c);
    i += 1;
  }
  return keys;
}

// ---- Dispatch ---------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const first = args[0];

  const flagValue = (flag) => {
    const a = args.find((x) => x === flag || x.startsWith(`${flag}=`));
    if (!a) return undefined;
    if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
    const idx = args.indexOf(a);
    return args[idx + 1];
  };

  if (!first) return runInteractive();
  if (first === "--help" || first === "-h") {
    printHelp();
    return 0;
  }
  if (first === "--list" || first === "-l") return runList();
  if (first === "--pull" || first.startsWith("--pull=")) {
    return runPull(flagValue("--pull"));
  }
  if (first === "--use" || first.startsWith("--use=")) {
    return runUse(flagValue("--use"));
  }
  process.stderr.write(`${red("✗")} unknown option: ${first}\n\n`);
  printHelp();
  return 1;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`${red("✗")} ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
