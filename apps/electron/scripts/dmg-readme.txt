SunFlower — a pixel sunflower that watches your screen and answers out loud,
100% locally. Open source, and this build stays open: the app carries its own
source code, and you can read it, change it, or replace it.


INSTALL

1. Drag SunFlower.app onto the Applications folder in this window.

   Drag it — don't copy it with sudo. Rebuilding after you edit the source
   writes inside the app, so it has to stay owned by you. If /Applications
   gives you trouble, ~/Applications works exactly the same.

2. Double-click it.

   Nothing appears in the Dock. That's correct — SunFlower is a menu-bar app.
   Look for the sunflower at the top right of your screen.

3. Install Ollama and pull a vision model. This is the one thing the app
   cannot bundle, because the model is several gigabytes:

     https://ollama.com     then:     ollama pull qwen3-vl:8b

If macOS refuses to open the app ("damaged", or "unidentified developer"),
this image travelled from another machine and got quarantined. Any of these
clears it, easiest first:

     right-click the app  ->  Open  ->  Open
     System Settings  ->  Privacy & Security  ->  Open Anyway
     xattr -dr com.apple.quarantine /Applications/SunFlower.app


VOICE AND THE GLOBAL SHORTCUT

Out of the box the flower sees your screen and answers, but does not listen:
speech-to-text and the global control-option hotkey need two native modules
that are compiled per machine, so they are not in this image. To turn them on:

     open /Applications/SunFlower.app/Contents/Resources/tools/
     double-click  install-cli.command
     then, in a terminal:   sunflower requirements --fix

That needs a network connection and the Xcode Command Line Tools
(`xcode-select --install`). It's a one-time step.


THE TERMINAL

install-cli.command also gives you the `sunflower` command. Launched from a
terminal, the flower has a full text interface, and closing the window closes
the flower — that is the original design, and it still works. The Finder
double-click gives you the detached app instead. Same code, two front doors.

     sunflower           the app, with its terminal UI
     sunflower-code      the coding harness, in the folder you're standing in
     sunflower models    browse and pull Ollama models
     sunflower requirements   check what's missing


MAKING IT YOURS

Right-click SunFlower.app -> Show Package Contents -> Contents/Resources/source

That folder is the repository, exactly as published. Edit anything in it, then
run Contents/Resources/tools/rebuild.command. It recompiles using the runtime
inside the app: no Node, no pnpm, no network needed.

To take a newer version from GitHub, run tools/update-from-github.command. It
clones, shows you what's coming, and only writes after you confirm — so you
can read the diff, or edit the clone first. Don't like an update? Don't run it.
Nothing checks for updates, nothing downloads on its own.

     https://github.com/Tromset/SunFlowerAssistant


ABOUT THIS BUILD

Apple Silicon only. The embedded Electron runtime is architecture-specific;
on an Intel Mac the app will not start.

Signed ad-hoc, not notarized. Nothing in this app talks to the network except
your own local Ollama. See Contents/Resources/BUILD-INFO.txt for the exact
commit this was built from.
