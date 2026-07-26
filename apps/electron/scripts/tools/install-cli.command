#!/bin/bash
# Installe les commandes `sunflower`, `sunflower-code`, `sunflower-models` et
# `sunflower-requirements` dans le PATH.
#
# C'est là que SunFlower redevient ce qu'il est vraiment : lancée depuis un
# terminal, la fleur a son TUI, et fermer la fenêtre la fait disparaître. Le
# double-clic dans le Finder donne l'app détachée ; les deux cohabitent, sur
# le même code.
#
# Les wrappers ne pointent PAS sur bin/sunflower.js directement : son shebang
# réclame un Node système, que ce bundle a justement pour but de ne pas exiger.
# Ils passent par l'Electron embarqué en mode node.
set -euo pipefail

BUNDLE=$(cd "$(dirname "$0")/../.." && pwd)
BIN="$BUNDLE/Contents/MacOS/SunFlower-bin"
BINDIR="$BUNDLE/Contents/Resources/source/apps/electron/bin"

# /usr/local/bin s'il est accessible en écriture, ~/.local/bin sinon — pas de
# sudo pour installer quatre liens.
TARGET="/usr/local/bin"
if [ ! -w "$TARGET" ]; then
  TARGET="$HOME/.local/bin"
  mkdir -p "$TARGET"
fi

echo "SunFlower — installing CLI commands into $TARGET"

for name in sunflower sunflower-code sunflower-models sunflower-requirements; do
  cat > "$TARGET/$name" <<EOF
#!/bin/bash
# Généré par SunFlower.app/Contents/Resources/tools/install-cli.command
exec env ELECTRON_RUN_AS_NODE=1 "$BIN" "$BINDIR/$name.js" "\$@"
EOF
  chmod +x "$TARGET/$name"
  echo "  $name"
done

echo
case ":$PATH:" in
  *":$TARGET:"*)
    echo "Done. Try: sunflower"
    ;;
  *)
    echo "Done — but $TARGET is not in your PATH. Add this to ~/.zshrc:"
    echo "  export PATH=\"$TARGET:\$PATH\""
    ;;
esac
echo
echo "Note: moving or renaming SunFlower.app breaks these commands."
echo "Run this again after moving it."
