// Bundles main / preload / renderers with esbuild and copies static assets.
// Usage: node scripts/build.mjs [--watch]
import { build, context } from "esbuild";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnQuiet } from "./native-log-filter.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const STATIC_EXT = new Set([".html", ".css", ".woff2", ".png", ".svg"]);

function copyStatics() {
  const src = path.join(root, "src", "renderer");
  const out = path.join(root, "dist", "renderer");
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (STATIC_EXT.has(path.extname(entry))) {
        const dest = path.join(out, path.relative(src, abs));
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(abs, dest);
      }
    }
  };
  walk(src);
}

// Sentinelle testée par bin/sunflower.js : absente => build incomplet.
function markBuildOk() {
  writeFileSync(path.join(root, "dist", ".build-ok"), "");
}

const rendererEntries = [
  "island/island.ts",
  "island/capture-worklet.ts",
  "companion/companion.ts",
  "panel/panel.ts",
  "pointer/pointer.ts",
  "onboarding/onboarding.ts",
  "orb/orb.ts",
  "work/work.ts",
  "code/code.ts",
].map((p) => path.join(root, "src", "renderer", p));

/** @type {import("esbuild").BuildOptions[]} */
const configs = [
  {
    entryPoints: [path.join(root, "src", "main", "index.ts")],
    outfile: path.join(root, "dist", "main", "index.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "uiohook-napi", "smart-whisper"],
    sourcemap: watch ? "inline" : false,
  },
  {
    entryPoints: [path.join(root, "src", "preload", "index.ts")],
    outfile: path.join(root, "dist", "preload", "index.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: watch ? "inline" : false,
  },
  {
    entryPoints: rendererEntries,
    outbase: path.join(root, "src", "renderer"),
    outdir: path.join(root, "dist", "renderer"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: watch ? "inline" : false,
  },
];

// Budget « always-on » (voir check-loops.mjs) : contrôlé À CHAQUE build, donc
// à chaque `pnpm start`. C'est le seul endroit où il s'exécute forcément — ce
// dépôt n'a pas de CI, et un contrôle que personne ne lance est pire que pas
// de contrôle du tout. En --watch il n'avertit que, pour ne pas bloquer une
// itération en cours.
const checkLoops = () => {
  const check = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "check-loops.mjs")],
    { cwd: root, stdio: "inherit" },
  );
  return check.status === 0;
};

rmSync(path.join(root, "dist"), { recursive: true, force: true });

if (!watch) {
  if (!checkLoops()) process.exit(1);
  await Promise.all(configs.map((c) => build(c)));
  copyStatics();
  markBuildOk();
} else {
  checkLoops();
  let child = null;
  let killing = false;
  const spawnApp = () => {
    const electron = createRequire(path.join(root, "package.json"))("electron");
    // stderr filtré : le bruit natif whisper.cpp/ggml part dans un fichier
    // de log au lieu de recouvrir le terminal (SUNFLOWER_DEBUG=1 = brut).
    child = spawnQuiet(electron, [root]);
  };
  // Attendre l'exit de l'ancienne instance : le verrou single-instance de
  // l'app n'est libéré qu'à sa sortie effective (teardown whisper compris).
  const relaunch = () => {
    if (killing) return;
    if (!child || child.exitCode !== null) {
      spawnApp();
      return;
    }
    killing = true;
    child.once("exit", () => {
      killing = false;
      spawnApp();
    });
    child.kill();
  };
  let timer = null;
  const scheduleRelaunch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copyStatics();
      markBuildOk();
      relaunch();
    }, 200);
  };
  const contexts = await Promise.all(
    configs.map((c) =>
      context({
        ...c,
        plugins: [
          {
            name: "relaunch",
            setup(b) {
              b.onEnd((result) => {
                if (result.errors.length === 0) scheduleRelaunch();
              });
            },
          },
        ],
      }),
    ),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  // Les .css/.html/.woff2 ne sont pas dans le graphe esbuild : watch dédié.
  fsWatch(
    path.join(root, "src", "renderer"),
    { recursive: true },
    (_event, filename) => {
      if (filename && STATIC_EXT.has(path.extname(filename))) {
        scheduleRelaunch();
      }
    },
  );
  const shutdown = () => {
    if (child) child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    if (child) child.kill();
  });
}
