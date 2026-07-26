// Fabrique `SunFlower.app`, dans deux modes très différents.
//
// ── Sans argument : un raccourci Finder vers le CLI, pas une app autonome.
//
// C'est le point important, et c'est un choix : sunflower VIT dans un
// terminal. Son interface principale est le TUI, ses réponses s'y écrivent,
// et fermer ce terminal doit la faire disparaître. Un bundle Electron
// classique ferait exactement l'inverse — une app détachée, sans terminal,
// qu'on ne retrouve que dans la barre de menus.
//
// Donc : le bundle ne contient pas Electron. Son exécutable ouvre un terminal
// sur la commande `sunflower`, et c'est tout. Electron hérite du TTY, le TUI
// s'affiche, et la fermeture de la fenêtre coupe `stdin` — ce que le main
// process écoute pour s'éteindre (voir « la fleur meurt avec son terminal »
// dans src/main/index.ts).
//
// Pas de signature ni de notarisation ici : le bundle est fabriqué localement,
// pour soi. macOS demandera confirmation au premier lancement.
//
// ── Avec `--bundled <staging>` : le bundle distribuable du DMG.
//
// Celui-là est autonome et déplaçable : il embarque Electron et les
// dépendances, ne suppose ni Node ni pnpm sur la machine, et ne grave aucun
// chemin absolu. Double-cliqué, il démarre l'app détachée (sans terminal,
// donc sans la mort au raccrochage — c'est le compromis assumé d'une app
// qu'on installe) ; la commande `sunflower`, elle, garde le comportement
// ci-dessus, TUI compris.
//
// Le bundle EST le bundle Electron, pas un lanceur qui en exécute un autre :
// un binaire posé dans SunFlower.app/Contents/MacOS appartient à
// SunFlower.app, donc les réglages Confidentialité, le nom et l'icône sont
// ceux de SunFlower et pas ceux d'« Electron ». Une seule copie du runtime.
//
//   node scripts/make-app.mjs [--out <dossier>]
//   node scripts/make-app.mjs --bundled <staging> [--vendor <dir>] [--out <dossier>]

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const stagingDir = flag("--bundled");
const outDir = path.resolve(flag("--out") ?? path.join(appRoot, "dist-app"));
const bundle = path.join(outDir, "SunFlower.app");
const pkg = JSON.parse(
  readFileSync(path.join(appRoot, "package.json"), "utf8"),
);
const icns = path.join(appRoot, "assets", "SunFlower.icns");

/* ─────────────────────────── mode raccourci ─────────────────────────── */

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SunFlower</string>
  <key>CFBundleDisplayName</key><string>SunFlower</string>
  <key>CFBundleIdentifier</key><string>com.sunflower.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>SunFlower</string>
  <key>CFBundleIconFile</key><string>SunFlower</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;

// Le terminal préféré s'il tourne déjà, Terminal.app sinon. Le test d'existence
// avant l'osascript évite quatre invites d'automatisation sur une machine qui
// n'a aucun de ces terminaux.
const PICK_TERMINAL = `TERM_APP="Terminal"
for candidate in Ghostty iTerm WezTerm kitty; do
  [ -d "/Applications/$candidate.app" ] || continue
  if /usr/bin/osascript -e "application \\"$candidate\\" is running" 2>/dev/null | grep -q true; then
    TERM_APP="$candidate"
    break
  fi
done`;

// Le lanceur cherche `sunflower` dans le PATH d'un shell de connexion (celui
// que `npm link` a garni), et retombe sur le bin du dépôt s'il n'y est pas —
// un clone sans `npm link` doit marcher aussi.
const SHORTCUT_LAUNCHER = `#!/bin/bash
# Ouvre un terminal sur sunflower. Généré par scripts/make-app.mjs — ne pas
# éditer ici, l'app est refabriquée à chaque \`pnpm --filter sunflower make-app\`.
set -euo pipefail

REPO_BIN=${JSON.stringify(path.join(appRoot, "bin", "sunflower.js"))}

# Le PATH d'une app lancée depuis le Finder est minimal : on repasse par un
# shell de connexion pour retrouver celui de l'utilisateur.
CMD=$(/bin/bash -lc 'command -v sunflower' 2>/dev/null || true)
if [ -z "$CMD" ]; then
  NODE=$(/bin/bash -lc 'command -v node' 2>/dev/null || true)
  if [ -z "$NODE" ]; then
    /usr/bin/osascript -e 'display alert "SunFlower" message "Node.js introuvable. Installez-le, puis relancez."'
    exit 1
  fi
  CMD="$NODE $REPO_BIN"
fi

# Un script jetable : \`open -a Terminal\` ne sait ouvrir qu'un fichier.
SCRIPT=$(/usr/bin/mktemp /tmp/sunflower-launch.XXXXXX)
{
  echo '#!/bin/bash'
  echo "rm -f '$SCRIPT'"
  echo "exec $CMD"
} > "$SCRIPT"
chmod +x "$SCRIPT"

${PICK_TERMINAL}

exec /usr/bin/open -a "$TERM_APP" "$SCRIPT"
`;

function makeShortcut() {
  if (existsSync(bundle)) rmSync(bundle, { recursive: true, force: true });
  mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });

  writeFileSync(path.join(bundle, "Contents", "Info.plist"), INFO_PLIST, "utf8");
  const exe = path.join(bundle, "Contents", "MacOS", "SunFlower");
  writeFileSync(exe, SHORTCUT_LAUNCHER, "utf8");
  chmodSync(exe, 0o755);

  // L'icône est optionnelle : sans .icns, macOS met l'icône générique et l'app
  // marche pareil. On ne fabrique pas de .icns ici (c'est le rôle de
  // scripts/make-icon.mjs), on copie celui du dépôt s'il existe.
  if (existsSync(icns)) {
    cpSync(icns, path.join(bundle, "Contents", "Resources", "SunFlower.icns"));
  }

  process.stdout.write(
    `SunFlower.app → ${bundle}\n` +
      `  glissez-le dans /Applications (ou gardez-le ici).\n` +
      `  premier lancement : clic droit → Ouvrir, macOS ne connaît pas ce bundle.\n` +
      (existsSync(icns)
        ? ""
        : "  (pas d'assets/SunFlower.icns : icône générique — `pnpm --filter sunflower make-icon`)\n"),
  );
}

/* ─────────────────────────── mode bundle ────────────────────────────── */

// Lanceur du bundle. Trois responsabilités et rien d'autre : réparer ce qu'un
// remplacement du source a pu casser, recompiler si le source a bougé,
// démarrer. Aucun chemin absolu — c'est ce qui rend le bundle déplaçable.
const BUNDLED_LAUNCHER = `#!/bin/bash
# Généré par scripts/make-app.mjs --bundled. Ne pas éditer ici : ce fichier est
# réécrit à chaque fabrication. Le code modifiable est dans Resources/source.
set -euo pipefail

BUNDLE=$(cd "$(dirname "$0")/../.." && pwd)
RES="$BUNDLE/Contents/Resources"
SRC="$RES/source"
APP="$SRC/apps/electron"
BIN="$BUNDLE/Contents/MacOS/SunFlower-bin"

fail() {
  /usr/bin/osascript -e "display alert \\"SunFlower\\" message \\"$1\\"" >/dev/null 2>&1 || true
  echo "sunflower: $1" >&2
  exit 1
}

[ -d "$SRC" ] || fail "Resources/source is missing — the app bundle is incomplete."
[ -x "$BIN" ] || fail "The embedded runtime is missing — reinstall from the DMG."

# Auto-réparation. node_modules est git-ignoré : remplacer Resources/source par
# un checkout GitHub efface ces liens. On les refait, ils ne coûtent rien — et
# c'est ce qui permet d'écraser le source sans réfléchir aux exclusions.
#
# Le test est \`-d\` et pas \`-e\` : sur un lien cassé (vendor déplacé, copie
# partielle) \`-e\` est faux ET \`ln -s\` échouerait sur un lien déjà là. \`-d\`
# suit le lien, et \`-sfn\` remplace au lieu de refuser.
[ -d "$SRC/node_modules" ] || ln -sfn ../vendor/node_modules "$SRC/node_modules"
[ -d "$APP/node_modules" ] || \\
  ln -sfn ../../../vendor/apps/electron/node_modules "$APP/node_modules"
[ -f "$SRC/.npmrc" ] || printf 'node-linker=hoisted\\n' > "$SRC/.npmrc"

# dist/.build-ok n'est écrit qu'à la toute fin d'un build : absent = source
# modifié, build interrompu, ou checkout tout neuf. Electron sait faire Node,
# donc on recompile sans Node système, sans pnpm et sans réseau.
if [ ! -f "$APP/dist/.build-ok" ]; then
  LOG="\${TMPDIR:-/tmp}/sunflower-build.log"
  if ! ELECTRON_RUN_AS_NODE=1 "$BIN" "$APP/scripts/build.mjs" > "$LOG" 2>&1; then
    fail "Rebuild failed. Details: $LOG"
  fi
fi

# cwd déterministe : main/index.ts s'en sert comme dossier de départ de
# Sunflower-Code. Lancé depuis le Finder, il vaudrait « / ».
cd "$HOME"
exec "$BIN" "$APP"
`;

/** Écrit une clé dans un Info.plist existant, sans le réécrire en entier. */
function plistSet(plist, key, type, value) {
  const set = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :${key} ${value}`,
    plist,
  ]);
  if (set.status === 0) return;
  const add = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Add :${key} ${type} ${value}`,
    plist,
  ]);
  if (add.status !== 0) {
    console.error(`make-app: could not set ${key} in ${plist}`);
    process.exit(1);
  }
}

function makeBundled() {
  const staging = path.resolve(stagingDir);
  const vendor = path.resolve(flag("--vendor") ?? `${staging}-vendor`);
  for (const [label, dir] of [
    ["staging", staging],
    ["vendor", vendor],
  ]) {
    if (!existsSync(dir)) {
      console.error(
        `make-app: ${label} directory not found: ${dir}\n` +
          `  run \`node scripts/stage-deps.mjs\` first.`,
      );
      process.exit(1);
    }
  }
  if (process.platform !== "darwin") {
    console.error("make-app --bundled: macOS only (needs PlistBuddy).");
    process.exit(1);
  }

  const electronApp = path.join(
    vendor,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
  );
  if (!existsSync(electronApp)) {
    console.error(`make-app: embedded Electron not found at ${electronApp}`);
    process.exit(1);
  }

  // 1. Le bundle EST Electron.app, renommé. Les frameworks et les trois
  //    helpers viennent avec, intacts.
  if (existsSync(bundle)) rmSync(bundle, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(electronApp, bundle, { recursive: true, verbatimSymlinks: true });

  const contents = path.join(bundle, "Contents");
  const macos = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");

  // 2. Le binaire prend un nom à part : l'exécutable déclaré est notre
  //    lanceur, qui a du travail à faire avant de passer la main.
  renameSync(path.join(macos, "Electron"), path.join(macos, "SunFlower-bin"));
  const exe = path.join(macos, "SunFlower");
  writeFileSync(exe, BUNDLED_LAUNCHER, "utf8");
  chmodSync(exe, 0o755);

  // 3. Info.plist : retouché clé par clé. Le plist d'Electron porte les
  //    descriptions d'usage (micro, etc.) — en réécrire un à la main les
  //    perdrait, et un NSMicrophoneUsageDescription manquant fait planter net
  //    à la première demande d'accès.
  const plist = path.join(contents, "Info.plist");
  plistSet(plist, "CFBundleExecutable", "string", "SunFlower");
  plistSet(plist, "CFBundleName", "string", "SunFlower");
  plistSet(plist, "CFBundleDisplayName", "string", "SunFlower");
  plistSet(plist, "CFBundleIdentifier", "string", "com.sunflower.app");
  plistSet(plist, "CFBundleIconFile", "string", "SunFlower");
  plistSet(plist, "CFBundleShortVersionString", "string", pkg.version);
  plistSet(plist, "CFBundleVersion", "string", pkg.version);
  plistSet(plist, "NSHumanReadableCopyright", "string", "MIT — open source");

  // 4. L'icône. `electron.icns` reste : rien ne le lit une fois
  //    CFBundleIconFile changé, et le retirer casserait le sceau d'Electron
  //    pour rien.
  if (existsSync(icns)) {
    cpSync(icns, path.join(resources, "SunFlower.icns"));
  } else {
    console.error(
      "make-app: assets/SunFlower.icns missing — run `node scripts/make-icon.mjs`.",
    );
    process.exit(1);
  }

  // 5. Le source modifiable, et les dépendances À CÔTÉ. `source` plutôt que
  //    `app` : Electron auto-charge Contents/Resources/app quand il démarre
  //    sans argument, et notre racine de workspace n'a pas de `main` — autant
  //    ne pas poser l'ambiguïté. Le nom dit aussi ce que c'est.
  cpSync(staging, path.join(resources, "source"), { recursive: true });
  cpSync(vendor, path.join(resources, "vendor"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  // 6. Electron n'est plus dans node_modules : il EST le bundle. On jette la
  //    copie (250 Mo en double) et on laisse une passerelle, pour que
  //    `require("electron")` — c'est-à-dire bin/sunflower.js:41 — trouve le
  //    binaire du bundle sans savoir qu'il est dans un bundle.
  const vendorElectron = path.join(
    resources,
    "vendor",
    "node_modules",
    "electron",
  );
  rmSync(path.join(vendorElectron, "dist"), { recursive: true, force: true });
  rmSync(path.join(vendorElectron, "path.txt"), { force: true });
  writeFileSync(
    path.join(vendorElectron, "index.js"),
    // __dirname = Contents/Resources/vendor/node_modules/electron
    //   ..(node_modules) ..(vendor) ..(Resources) ..(Contents) → MacOS/
    "// Passerelle du bundle SunFlower : Electron n'est pas ici, il EST le\n" +
      "// bundle. Même contrat que le paquet npm — on exporte le chemin du\n" +
      "// binaire — mais atteint en relatif, donc déplaçable.\n" +
      'module.exports = require("node:path").join(\n' +
      '  __dirname,\n  "..",\n  "..",\n  "..",\n  "..",\n' +
      '  "MacOS",\n  "SunFlower-bin",\n' +
      ");\n",
    "utf8",
  );

  // 7. Les liens que le lanceur sait réparer — posés une première fois ici
  //    pour qu'un bundle fraîchement fabriqué soit déjà complet.
  const src = path.join(resources, "source");
  linkIfAbsent(path.join(src, "node_modules"), "../vendor/node_modules");
  linkIfAbsent(
    path.join(src, "apps", "electron", "node_modules"),
    "../../../vendor/apps/electron/node_modules",
  );

  // 8. De quoi savoir ce qu'on a entre les mains six mois plus tard.
  const sha =
    spawnSync("git", ["-C", appRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).stdout?.trim() || "unknown";
  writeFileSync(
    path.join(resources, "BUILD-INFO.txt"),
    [
      `SunFlower ${pkg.version}`,
      `commit    ${sha}`,
      `built     ${new Date().toISOString()}`,
      `arch      ${process.arch}`,
      `electron  ${readElectronVersion(resources)}`,
      "",
      "The editable source is Contents/Resources/source — it is the repository,",
      "exactly as published. Replace it with a newer checkout, delete",
      "apps/electron/dist/.build-ok, and relaunch.",
      "",
    ].join("\n"),
    "utf8",
  );

  copyTools(resources);

  process.stdout.write(
    `SunFlower.app → ${bundle}\n` +
      `  standalone: embedded Electron, no system Node, no pnpm.\n` +
      `  editable source at Contents/Resources/source.\n`,
  );
}

function linkIfAbsent(linkPath, target) {
  if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

function readElectronVersion(resources) {
  try {
    return readFileSync(
      path.join(resources, "vendor", "node_modules", "electron", "package.json"),
      "utf8",
    ).match(/"version":\s*"([^"]+)"/)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Les outils vivent DANS le bundle, pas sur l'image disque : un .command posé
// sur un DMG en lecture seule et sous quarantaine ne s'exécute pas.
function copyTools(resources) {
  const from = path.join(appRoot, "scripts", "tools");
  if (!existsSync(from)) return;
  const to = path.join(resources, "tools");
  cpSync(from, to, { recursive: true });
  // Le bit d'exécution ne survit pas toujours à une copie ; sans lui, un
  // double-clic dans le Finder ouvre le script dans un éditeur.
  for (const name of readdirSync(to)) {
    if (name.endsWith(".command")) chmodSync(path.join(to, name), 0o755);
  }
}

if (stagingDir) makeBundled();
else makeShortcut();
