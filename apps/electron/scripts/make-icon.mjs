// Fabrique `assets/SunFlower.icns` — l'icône du bundle Finder — à partir de
// `APP_ICON` (src/shared/sunflower-pixels.ts).
//
// Aucune dépendance nouvelle : `pixelArtPng` (src/main/pixel-png.ts) sait déjà
// rasteriser un PixelArt en PNG, c'est ce dont le tray se sert. On lui demande
// les sept tailles d'un icône macOS, puis on les emballe.
//
// L'emballage se fait ici plutôt que par `iconutil` : depuis macOS 10.7 un
// .icns n'est qu'un en-tête suivi de chunks « OSType + longueur + PNG brut »,
// donc l'écrire nous-mêmes coûte vingt lignes et rend le script utilisable
// hors macOS (conteneur, CI Linux). Sur un Mac, `iconutil` reste préféré quand
// il est là : c'est l'outil d'Apple, il fait autorité.
//
// Le résultat est committé : un clone frais doit avoir une vraie icône sans
// que personne ait à penser à relancer ce script. On ne le relance que quand
// l'art change.
//
//   node scripts/make-icon.mjs [--out <fichier.icns>] [--iconset] [--no-iconutil]

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const icnsPath = path.resolve(
  flagValue("--out") ?? path.join(root, "assets", "SunFlower.icns"),
);
const iconsetDir = path.join(root, "dist-app", "SunFlower.iconset");

// Une seule table pour les deux sorties. `scale` est un entier — c'est la
// raison d'être de la viewBox 16 : 16×64 = 1024 pile, sans interpolation.
// `type` est l'OSType du chunk .icns, `file` le nom canonique de l'iconset.
// icp5/ic11 et ic13/ic08, ic14/ic09 font la même taille : c'est normal, macOS
// distingue « 32 natif » de « 16 en @2x » même quand l'image est identique.
const SIZES = [
  { scale: 1, type: "icp4", file: "icon_16x16.png" },
  { scale: 2, type: "ic11", file: "icon_16x16@2x.png" },
  { scale: 2, type: "icp5", file: "icon_32x32.png" },
  { scale: 4, type: "ic12", file: "icon_32x32@2x.png" },
  { scale: 8, type: "ic07", file: "icon_128x128.png" },
  { scale: 16, type: "ic13", file: "icon_128x128@2x.png" },
  { scale: 16, type: "ic08", file: "icon_256x256.png" },
  { scale: 32, type: "ic14", file: "icon_256x256@2x.png" },
  { scale: 32, type: "ic09", file: "icon_512x512.png" },
  { scale: 64, type: "ic10", file: "icon_512x512@2x.png" },
];

// Charger du TypeScript depuis un script .mjs sans rien installer : esbuild est
// déjà une devDependency, on bundle en mémoire et on importe le résultat par
// une URL `data:`. Pas de fichier temporaire, pas de ts-node. Les specifiers
// relatifs ont été inlinés par `bundle: true` ; seuls les `node:` restent, et
// une URL `data:` sait les résoudre.
const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");

function loadTs(relative) {
  const [file] = buildSync({
    entryPoints: [path.join(root, relative)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    // Le tsconfig du dépôt étend @piksy/config, résolu par pnpm — inutile ici,
    // et esbuild avertirait à chaque appel s'il essayait de le lire.
    tsconfigRaw: {},
  }).outputFiles;
  return import(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(file.text)}`
  );
}

/** Emballe des PNG déjà encodés dans un .icns. */
function encodeIcns(parts) {
  const chunks = parts.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(png.length + 8, 4); // longueur EN-TÊTE COMPRIS
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const { pixelArtPng } = await loadTs("src/main/pixel-png.ts");
const { APP_ICON } = await loadTs("src/shared/sunflower-pixels.ts");

const [vw, vh] = APP_ICON.vb;
if (vw !== vh) {
  console.error(`make-icon: APP_ICON must be square, got ${vw}×${vh}.`);
  process.exit(1);
}

const cache = new Map();
const png = (scale) => {
  if (!cache.has(scale)) cache.set(scale, pixelArtPng(APP_ICON, scale));
  return cache.get(scale);
};

mkdirSync(path.dirname(icnsPath), { recursive: true });

// Sur un Mac avec les outils Xcode, on passe par iconutil : même entrée, même
// sortie, mais c'est l'implémentation d'Apple qui tranche.
const wantIconutil =
  process.platform === "darwin" && !args.includes("--no-iconutil");
const haveIconutil =
  wantIconutil && spawnSync("iconutil", ["--help"]).error === undefined;

if (haveIconutil || args.includes("--iconset")) {
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  for (const { scale, file } of SIZES) {
    writeFileSync(path.join(iconsetDir, file), png(scale));
  }
}

if (haveIconutil) {
  const out = spawnSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath], {
    stdio: "inherit",
  });
  if (out.error || out.status !== 0) {
    console.error("make-icon: iconutil failed.");
    process.exit(out.status ?? 1);
  }
  if (!args.includes("--iconset")) {
    rmSync(iconsetDir, { recursive: true, force: true });
  }
} else {
  writeFileSync(
    icnsPath,
    encodeIcns(SIZES.map(({ scale, type }) => ({ type, png: png(scale) }))),
  );
  if (wantIconutil) {
    process.stdout.write(
      "make-icon: iconutil not found — wrote the .icns directly.\n",
    );
  }
}

// Relecture : l'en-tête annonce la taille du fichier, un décalage se voit tout
// de suite. Bon marché, et ça évite de committer un .icns tronqué.
const written = readFileSync(icnsPath);
if (written.subarray(0, 4).toString("ascii") !== "icns") {
  console.error("make-icon: output is not an icns file.");
  process.exit(1);
}
if (written.readUInt32BE(4) !== statSync(icnsPath).size) {
  console.error(
    `make-icon: icns header says ${written.readUInt32BE(4)} bytes, file is ${statSync(icnsPath).size}.`,
  );
  process.exit(1);
}

process.stdout.write(
  `SunFlower.icns → ${path.relative(root, icnsPath)} ` +
    `(${SIZES.length} sizes, ${vw}–${vw * 64} px, ${written.length} bytes)\n` +
    `  commit it: a fresh clone should get a real icon from make-app alone.\n` +
    `  if the Finder still shows the generic icon, it's the icon cache:\n` +
    `    touch dist-app/SunFlower.app, then killall Finder.\n`,
);
