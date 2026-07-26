// Fabrique `SunFlower.app` — un raccourci Finder vers le CLI, pas une app
// autonome.
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
//   node scripts/make-app.mjs [--out <dossier>]

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = path.resolve(
  outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : path.join(appRoot, "dist-app"),
);
const bundle = path.join(outDir, "SunFlower.app");

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SunFlower</string>
  <key>CFBundleDisplayName</key><string>SunFlower</string>
  <key>CFBundleIdentifier</key><string>com.sunflower.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>SunFlower</string>
  <key>CFBundleIconFile</key><string>SunFlower</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;

// Le lanceur cherche `sunflower` dans le PATH d'un shell de connexion (celui
// que `npm link` a garni), et retombe sur le bin du dépôt s'il n'y est pas —
// un clone sans `npm link` doit marcher aussi.
const LAUNCHER = `#!/bin/bash
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

# Le terminal préféré s'il tourne déjà, Terminal.app sinon.
TERM_APP="Terminal"
for candidate in Ghostty iTerm WezTerm kitty; do
  if /usr/bin/osascript -e "application \\"$candidate\\" is running" 2>/dev/null | grep -q true; then
    TERM_APP="$candidate"
    break
  fi
done

exec /usr/bin/open -a "$TERM_APP" "$SCRIPT"
`;

if (existsSync(bundle)) rmSync(bundle, { recursive: true, force: true });
mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });

writeFileSync(path.join(bundle, "Contents", "Info.plist"), INFO_PLIST, "utf8");
const exe = path.join(bundle, "Contents", "MacOS", "SunFlower");
writeFileSync(exe, LAUNCHER, "utf8");
chmodSync(exe, 0o755);

// L'icône est optionnelle : sans .icns, macOS met l'icône générique et l'app
// marche pareil. On ne fabrique pas de .icns ici (ça demanderait iconutil et
// un jeu de PNG), on copie celui du dépôt s'il existe.
const icns = path.join(appRoot, "assets", "SunFlower.icns");
if (existsSync(icns)) {
  cpSync(icns, path.join(bundle, "Contents", "Resources", "SunFlower.icns"));
}

process.stdout.write(
  `SunFlower.app → ${bundle}\n` +
    `  glissez-le dans /Applications (ou gardez-le ici).\n` +
    `  premier lancement : clic droit → Ouvrir, macOS ne connaît pas ce bundle.\n` +
    (existsSync(icns) ? "" : "  (pas d'assets/SunFlower.icns : icône générique)\n"),
);
