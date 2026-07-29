"use strict";
// Lanceur silencieux : whisper.cpp et ggml (Metal) écrivent leurs logs en C
// directement sur le stderr du process Electron — inatteignable depuis
// JavaScript — et chaque transcription réimprime toute son init (état
// whisper + contexte Metal) par-dessus l'interface terminal. Remède :
// spawner Electron avec stderr sur un tube, ranger ces lignes de bruit natif
// dans un fichier sous userData, et laisser passer tout le reste (vraies
// erreurs) vers notre stderr. SUNFLOWER_DEBUG=1 désactive le filtre.
const { spawn } = require("node:child_process");
const {
  createWriteStream,
  mkdirSync,
  renameSync,
  statSync,
} = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");

// Préfixes de whisper.cpp (whisper_log) et de ggml (fprintf bruts dans
// ggml-alloc.c / ggml-backend.c / ggml-metal.m). Les lignes vides séparent
// ces mêmes blocs.
const NOISE = /^(whisper_|ggml_)|^\s*$/;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Reflète app.getPath("userData") d'Electron pour l'app "sunflower" — on
// tourne dans le node du lanceur, avant qu'Electron n'existe.
function userDataDir() {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "sunflower");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "sunflower",
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        "sunflower",
      );
  }
}

function openLogSink() {
  try {
    const dir = path.join(userDataDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "native.log");
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`);
    } catch {
      // fichier absent — rien à faire
    }
    const sink = createWriteStream(file, { flags: "a" });
    sink.on("error", () => {
      // disque plein ou dossier retiré en cours de route : bruit jeté
    });
    sink.write(`--- sunflower ${new Date().toISOString()} ---\n`);
    return sink;
  } catch {
    return null; // pas de fichier possible — le bruit est simplement jeté
  }
}

/**
 * Spawn `bin` avec stdin/stdout hérités et stderr filtré. `onClose(code)`
 * est appelé après la sortie du process ET la vidange du tube stderr (les
 * dernières lignes d'un crash arrivent après l'exit), garde-fou d'1 s.
 * `env` remplace l'environnement hérité — bin/sunflower.js s'en sert pour
 * retirer ELECTRON_RUN_AS_NODE avant de lancer la vraie app.
 */
function spawnQuiet(bin, args, opts = {}) {
  const { onClose, env } = opts;
  if (process.env.SUNFLOWER_DEBUG === "1") {
    const child = spawn(bin, args, { stdio: "inherit", env: env ?? process.env });
    if (onClose) child.on("exit", (code) => onClose(code ?? 0));
    return child;
  }
  const child = spawn(bin, args, {
    stdio: ["inherit", "inherit", "pipe"],
    env: env ?? process.env,
  });
  const sink = openLogSink();
  let drained = false;
  let exitCode = null;
  let closed = false;
  function notify() {
    if (!onClose || closed || exitCode === null || !drained) return;
    closed = true;
    onClose(exitCode);
  }
  const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (NOISE.test(line)) sink?.write(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  });
  rl.on("close", () => {
    drained = true;
    sink?.end();
    notify();
  });
  child.on("exit", (code) => {
    exitCode = code ?? 0;
    notify();
    if (!drained) {
      setTimeout(() => {
        drained = true;
        notify();
      }, 1000).unref();
    }
  });
  return child;
}

module.exports = { spawnQuiet };
