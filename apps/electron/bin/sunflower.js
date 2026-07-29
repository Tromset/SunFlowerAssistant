#!/usr/bin/env node
// Global `sunflower` command (npm link): build if needed, then launch Electron.
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

// `sunflower models` / `sunflower requirements` : sous-commandes autonomes,
// zéro build/Electron requis.
const SUBCOMMANDS = {
  models: "sunflower-models.js",
  requirements: "sunflower-requirements.js",
};
const sub = SUBCOMMANDS[process.argv[2]];
if (sub) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, sub), ...process.argv.slice(3)],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
  return;
}

// `sunflower code` : PAS une sous-commande autonome — c'est l'app complète,
// avec la fenêtre Sunflower-Code ouverte d'entrée. Traduit en drapeau
// explicite plutôt que laissé nu : main/index.ts ne devine pas ce que veut
// dire un argument qui s'appelle « code ».
const forward = process.argv.slice(2);
if (forward[0] === "code") forward[0] = "--open-code";

const appRoot = path.resolve(__dirname, "..");
// stderr filtré : le bruit natif whisper.cpp/ggml part dans un fichier de
// log, le terminal ne garde que le dialogue (SUNFLOWER_DEBUG=1 = tout brut).
const { spawnQuiet } = require(
  path.join(appRoot, "scripts", "native-log-filter.cjs"),
);

const resolveElectron = () => {
  try {
    return require(require.resolve("electron", { paths: [appRoot] }));
  } catch {
    return null;
  }
};

let electronBin = resolveElectron();
if (!electronBin) {
  // requirements.txt en action : depuis un clone frais, le binaire global
  // installe lui-même les dépendances au lieu d'exiger un pnpm install manuel.
  console.error("sunflower: dependencies missing — running pnpm install …");
  // Racine du projet global (pnpm-workspace.yaml) en remontant depuis
  // apps/electron ; même logique que bin/sunflower-requirements.js.
  let workspaceRoot = appRoot;
  for (let dir = appRoot, i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      workspaceRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const install = spawnSync("pnpm", ["install"], {
    cwd: workspaceRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.error || install.status !== 0 || !(electronBin = resolveElectron())) {
    console.error(
      "sunflower: electron still not found — run `sunflower requirements --fix` for a full check.",
    );
    process.exit(1);
  }
}

// dist/.build-ok is only written at the very end of a build: a partial build
// (interrupted, or a failed renderer bundle) triggers a rebuild.
if (!existsSync(path.join(appRoot, "dist", ".build-ok"))) {
  const build = spawnSync(
    process.execPath,
    [path.join(appRoot, "scripts", "build.mjs")],
    { cwd: appRoot, stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// Si ce script tourne lui-même sous Electron en mode node
// (ELECTRON_RUN_AS_NODE=1), les deux spawns précédents veulent en hériter —
// ce sont des scripts node. Celui-ci non : hérité tel quel, il démarrerait la
// vraie app en node, sans fenêtre ni barre de menus. Il ne part que d'ici.
const appEnv = { ...process.env };
delete appEnv.ELECTRON_RUN_AS_NODE;

spawnQuiet(electronBin, [appRoot, ...forward], {
  env: appEnv,
  onClose: (code) => process.exit(code),
});
