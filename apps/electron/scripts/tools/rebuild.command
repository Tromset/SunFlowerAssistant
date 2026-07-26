#!/bin/bash
# Recompile SunFlower après une modification de son code source.
#
# Le double-clic depuis le Finder marche : un .command s'ouvre dans Terminal.
# Rien à installer — le Node utilisé est celui d'Electron, dans le bundle.
set -euo pipefail

BUNDLE=$(cd "$(dirname "$0")/../.." && pwd)
RES="$BUNDLE/Contents/Resources"
APP="$RES/source/apps/electron"
BIN="$BUNDLE/Contents/MacOS/SunFlower-bin"

echo "SunFlower — rebuilding from source"
echo "  bundle: $BUNDLE"
echo

if [ ! -x "$BIN" ]; then
  echo "The embedded runtime is missing. Reinstall from the DMG." >&2
  exit 1
fi
if [ ! -w "$APP" ]; then
  echo "Cannot write to the source folder." >&2
  echo "The app was probably installed with sudo. Reinstall it by dragging," >&2
  echo "or keep it in ~/Applications instead." >&2
  exit 1
fi

# La sentinelle n'est écrite qu'à la toute fin d'un build réussi : la retirer
# est le geste documenté pour forcer une recompilation complète.
rm -f "$APP/dist/.build-ok"

ELECTRON_RUN_AS_NODE=1 "$BIN" "$APP/scripts/build.mjs"

# Re-sceller. Éditer le source invalide le sceau des ressources — pas la
# signature des binaires, qu'on ne touche pas. On re-signe le bundle
# EXTÉRIEUR uniquement : les autorisations micro/écran/accessibilité sont
# accrochées au binaire, et le laisser tranquille est ce qui leur donne une
# chance de survivre.
codesign --force --sign - "$BUNDLE" 2>/dev/null || {
  echo "note: could not re-sign the bundle (harmless unless it is quarantined)."
}

echo
echo "Done. Launch SunFlower."
