#!/bin/bash
# Remplace le code source de l'app par la dernière version publiée sur GitHub.
#
# C'est la mise à jour de SunFlower, et elle n'a rien d'automatique : rien ne
# vérifie une version au démarrage, rien ne télécharge dans ton dos. Tu la
# lances quand tu veux, et tu peux relire ou modifier le code avant qu'il
# n'entre dans l'app (le clone reste dans /tmp, l'écriture ne se fait qu'après
# ta confirmation).
set -euo pipefail

REPO="https://github.com/Tromset/SunFlowerAssistant.git"
BUNDLE=$(cd "$(dirname "$0")/../.." && pwd)
RES="$BUNDLE/Contents/Resources"
SRC="$RES/source"
APP="$SRC/apps/electron"
BIN="$BUNDLE/Contents/MacOS/SunFlower-bin"
CLONE=$(mktemp -d "${TMPDIR:-/tmp}/sunflower-update.XXXXXX")

cleanup() { rm -rf "$CLONE"; }
trap cleanup EXIT

echo "SunFlower — update from GitHub"
echo "  bundle: $BUNDLE"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed. Install the Xcode Command Line Tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi
if [ ! -w "$SRC" ]; then
  echo "Cannot write to $SRC — the app was probably installed with sudo." >&2
  exit 1
fi

echo "Cloning $REPO …"
git clone --depth 1 "$REPO" "$CLONE" 2>&1 | sed 's/^/  /'
NEW_SHA=$(git -C "$CLONE" rev-parse --short HEAD)
echo

# Les dépendances sont le seul point que le bundle ne sait pas résoudre tout
# seul : elles vivent hors du source, et un lockfile différent veut dire qu'il
# en manque. Autant le dire franchement plutôt que d'échouer au lancement.
if ! diff -q "$CLONE/pnpm-lock.yaml" "$SRC/pnpm-lock.yaml" >/dev/null 2>&1; then
  echo "⚠  Dependencies changed since this build (pnpm-lock.yaml differs)."
  echo "   The bundle carries its own node_modules and cannot install new ones"
  echo "   offline. After updating, run — once, with a network connection:"
  echo "     cd '$SRC' && pnpm install"
  echo
fi

echo "Incoming: $NEW_SHA"
echo "You can inspect or edit $CLONE before continuing."
printf "Replace the app's source with it? [y/N] "
read -r answer
case "$answer" in
  [yY]*) ;;
  *) echo "Cancelled — nothing was changed."; exit 0 ;;
esac

# --delete pour que les fichiers supprimés en amont disparaissent, et des
# exclusions pour ce qui n'appartient pas au dépôt : les liens vers vendor, le
# build, le .npmrc du bundle. Même sans elles le lanceur réparerait au
# démarrage suivant — les exclusions évitent juste une recompilation inutile.
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude 'apps/electron/dist' \
  --exclude '.npmrc' \
  "$CLONE/" "$SRC/"

rm -f "$APP/dist/.build-ok"
echo
echo "Rebuilding …"
ELECTRON_RUN_AS_NODE=1 "$BIN" "$APP/scripts/build.mjs"

codesign --force --sign - "$BUNDLE" 2>/dev/null || true

echo
echo "Updated to $NEW_SHA. Launch SunFlower."
echo "Don't like it? The source is plain files in $SRC — edit them, or run this"
echo "again after checking out an older commit in the clone."
