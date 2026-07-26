// Prépare ce que le bundle .app va contenir : le source, et un `node_modules`
// qu'on peut copier.
//
// Le « qu'on peut copier » est tout le problème. Ce dépôt n'a pas de `.npmrc`,
// donc pnpm installe en `node-linker=isolated` : `node_modules` est une forêt
// de liens vers le magasin global (~/Library/pnpm/store). Un `cp -R` en sort
// un arbre mort, et un `cp -RL` déréférence des liens qui pointent les uns
// vers les autres. On réinstalle donc à plat, dans une copie.
//
// Deux sorties, côte à côte, et c'est délibéré :
//   dist-app/staging/         le source seul, tel qu'il est sur GitHub
//   dist-app/staging-vendor/  les node_modules, en dehors du source
// Le bundle garde cette séparation : remplacer le source par un checkout
// GitHub ne peut alors pas emporter les dépendances avec lui.
//
//   node scripts/stage-deps.mjs [--keep]

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// Racine du workspace, même remontée que bin/sunflower.js:54-63.
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
if (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
  console.error("stage-deps: pnpm-workspace.yaml not found above apps/electron.");
  process.exit(1);
}

const staging = path.join(appRoot, "dist-app", "staging");
const vendor = path.join(appRoot, "dist-app", "staging-vendor");

const run = (cmd, argv, cwd) => {
  const r = spawnSync(cmd, argv, { cwd, stdio: "inherit" });
  if (r.error) {
    console.error(`stage-deps: cannot run ${cmd} — is it installed?`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/* 1. Le source : uniquement ce que git suit. */

if (!args.includes("--keep")) {
  rmSync(staging, { recursive: true, force: true });
  rmSync(vendor, { recursive: true, force: true });
}
mkdirSync(staging, { recursive: true });

// `git ls-files` plutôt qu'une copie du dossier : garantit que le source livré
// est exactement celui publié sur GitHub. Pas de .env oublié, pas de dist/
// périmé, pas de .DS_Store — et pas de .git, 3,5 Mo inutiles puisque l'outil
// de mise à jour clone à neuf.
const listed = spawnSync("git", ["-C", workspaceRoot, "ls-files", "-z"], {
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024,
});
if (listed.status !== 0) {
  console.error("stage-deps: `git ls-files` failed — is this a git checkout?");
  process.exit(1);
}
const files = listed.stdout
  .toString("utf8")
  .split("\0")
  .filter((f) => f.length > 0);
for (const rel of files) {
  const from = path.join(workspaceRoot, rel);
  if (!existsSync(from)) continue; // fichier suivi mais supprimé localement
  const to = path.join(staging, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}
process.stdout.write(`stage-deps: ${files.length} tracked files → staging\n`);

/* 2. Un linker à plat, et pas de compilation native. */

// Un fichier plutôt qu'un drapeau : il survit dans le bundle, donc un futur
// `pnpm install` lancé DANS l'app reste à plat lui aussi. Le lanceur le
// recrée si un checkout GitHub l'a effacé.
writeFileSync(path.join(staging, ".npmrc"), "node-linker=hoisted\n", "utf8");

// smart-whisper compile whisper.cpp depuis les sources (il faut Xcode CLT) et
// uiohook-napi pose un binaire natif ; les deux sont propres à une
// architecture. On les sort du bundle : `sunflower requirements --fix` les
// installe sur la machine de l'utilisateur, quand il veut la voix et le ⌃⌥.
// Le code s'y attend déjà — stt.ts:87 et hotkey.ts:56 dégradent sans lever.
const NATIVE = ["smart-whisper", "uiohook-napi"];
const wsPath = path.join(staging, "pnpm-workspace.yaml");
let ws = readFileSync(wsPath, "utf8");
for (const name of NATIVE) {
  const before = ws;
  ws = ws.replace(
    new RegExp(`^(\\s*)${name}:\\s*true\\s*$`, "m"),
    `$1${name}: false`,
  );
  if (ws === before) {
    console.error(
      `stage-deps: could not disable the build of ${name} in pnpm-workspace.yaml.\n` +
        `  allowBuilds no longer has a \`${name}: true\` line — check the file.`,
    );
    process.exit(1);
  }
}
writeFileSync(wsPath, ws, "utf8");

/* 3. L'installation. */

// --filter sunflower... : la fermeture de dépendances de l'app seule. Laisse
// dehors wrangler/Cloudflare (apps/server) et turbo, soit quelques centaines
// de Mo qui n'ont rien à faire dans un bundle.
//
// PAS de --prod : esbuild et typescript sont chargés à l'EXÉCUTION ici.
// bin/sunflower.js:79 peut relancer build.mjs, qui lance check-loops.mjs, qui
// require("typescript"). Les élaguer tuerait l'auto-modification, qui est
// toute la raison d'être de ce bundle.
const install = spawnSync(
  "pnpm",
  ["install", "--frozen-lockfile", "--filter", "sunflower..."],
  { cwd: staging, stdio: "inherit" },
);
if (install.error) {
  console.error("stage-deps: pnpm not found — install it to build the DMG.");
  process.exit(1);
}
if (install.status !== 0) {
  // Deux causes plausibles, et le remède n'est pas le même : soit le lockfile
  // gelé refuse le pnpm-workspace.yaml retouché, soit --filter se comporte
  // autrement que prévu sur cette version de pnpm.
  console.error(
    "\nstage-deps: the staging install failed.\n" +
      "  If pnpm complained about the lockfile, drop --frozen-lockfile:\n" +
      `    cd ${path.relative(process.cwd(), staging)} && pnpm install --filter 'sunflower...'\n` +
      "  If it was --filter, install everything and prune afterwards:\n" +
      "    pnpm install && rm -rf apps/server/node_modules node_modules/turbo node_modules/wrangler\n" +
      "  Then re-run with --keep to reuse this staging directory.\n",
  );
  process.exit(install.status ?? 1);
}

// Les modules natifs sont installés (le lockfile est figé) mais pas compilés.
// On retire les dossiers : du poids mort, et un binding à moitié installé
// donne un message d'erreur moins clair qu'une absence franche.
for (const name of NATIVE) {
  for (const base of [
    path.join(staging, "node_modules"),
    path.join(staging, "apps", "electron", "node_modules"),
  ]) {
    rmSync(path.join(base, name), { recursive: true, force: true });
  }
}

/* 4. Le build, fait ici pour qu'une installation neuve n'ait rien à écrire. */

run(
  process.execPath,
  [path.join(staging, "apps", "electron", "scripts", "build.mjs")],
  path.join(staging, "apps", "electron"),
);
if (!existsSync(path.join(staging, "apps", "electron", "dist", ".build-ok"))) {
  console.error("stage-deps: build finished without writing dist/.build-ok.");
  process.exit(1);
}

/* 5. Séparer les dépendances du source. */

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
renameSync(path.join(staging, "node_modules"), path.join(vendor, "node_modules"));
const appModules = path.join(staging, "apps", "electron", "node_modules");
if (existsSync(appModules)) {
  mkdirSync(path.join(vendor, "apps", "electron"), { recursive: true });
  renameSync(appModules, path.join(vendor, "apps", "electron", "node_modules"));
}

const electronDist = path.join(
  vendor,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);
if (!existsSync(electronDist)) {
  console.error(
    `stage-deps: Electron runtime missing at ${electronDist}\n` +
      "  the postinstall that downloads it did not run — check allowBuilds.",
  );
  process.exit(1);
}

process.stdout.write(
  `staging  → ${path.relative(appRoot, staging)}\n` +
    `vendor   → ${path.relative(appRoot, vendor)}\n` +
    `  native modules excluded (${NATIVE.join(", ")}): voice and the global ⌃⌥\n` +
    `  stay off until \`sunflower requirements --fix\` installs them.\n`,
);
