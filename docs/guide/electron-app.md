# Electron app — `sunflower` (100 % local)

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [guide: terminal](terminal.md), [internals: cli-tools](../internals/cli-tools.md), [internals: architecture](../internals/architecture.md)

`apps/electron` is a second, fully local implementation of the companion, built from the Claude Design prototype in `app-electron-avec-tournesol-local/`. Unlike the Swift app + Worker pair, it needs **no server, no Clerk, no API keys**: push-to-talk (hold ⌃ ⌥) → mic capture → **local Whisper** transcription (whisper.cpp, Metal) → screenshot → **local Ollama** vision model → streamed answer in a speech bubble next to a pixel-art sunflower that follows your cursor, spoken aloud with the macOS system voice. English UI, in the app's black-and-yellow theme.

Surfaces: a status island under the menu-bar notch, the cursor-following sunflower companion with its speech bubble, an orange pointing overlay that frames the one element the model points at — sized to that element's bounding box (see "Pointing" below), a menu-bar tray panel (live permissions, model status, moods, work, quit), a dedicated **Sunflower Work** window, a dedicated **Sunflower-Code** window, and a 3-step onboarding on first launch.

### Screenshots

The onboarding walks through welcome, permissions, and the local-model check — in the same black-and-yellow theme as the running app:

| Welcome | Permissions | Local model |
| --- | --- | --- |
| ![Onboarding welcome step](../../apps/electron/docs/screenshots/onboarding-welcome.png) | ![Onboarding permissions step](../../apps/electron/docs/screenshots/onboarding-permissions.png) | ![Onboarding local-model step](../../apps/electron/docs/screenshots/onboarding-model.png) |

The menu-bar panel shows live permission, model, and voice status:

![Menu-bar panel](../../apps/electron/docs/screenshots/panel.png)

The status island sits under the notch while sunflower listens and answers, and the cursor-following companion streams the reply in a speech bubble:

| Listening | Answering | Companion |
| --- | --- | --- |
| ![Island listening state](../../apps/electron/docs/screenshots/island-listening.png) | ![Island answering state](../../apps/electron/docs/screenshots/island-answering.png) | ![Cursor companion with speech bubble](../../apps/electron/docs/screenshots/companion.png) |

### Run it from source

```bash
pnpm install        # once, at the repo root (builds whisper.cpp — needs Xcode CLT)
npm start           # at the repo root (or in apps/electron)
```

Or install the global command:

```bash
cd apps/electron
npm link
sunflower           # from anywhere
sunflower-code      # the coding harness, in whatever folder you're standing in
sunflower code      # same thing via the main CLI
```

`npm link` registers four bins: `sunflower`, `sunflower-code`, `sunflower-models`
and `sunflower-requirements`. Check with `which sunflower-code`. If your setup
doesn't do symlinks, one by hand works just as well:

```bash
ln -s "$PWD/apps/electron/bin/sunflower-code.js" /usr/local/bin/sunflower-code
```

**Why `sunflower-code` rather than just `sunflower code`:** it passes the folder
you launched it from, so the harness starts on *that* project instead of making
you type `/cd` on arrival. `sunflower-code --cd ~/other-project` aims elsewhere
without moving.

### In the Finder, running in your terminal

This is a shortcut bundle that points at your checkout — it does not carry a
copy of the app.

```bash
pnpm --filter sunflower make-app     # writes apps/electron/dist-app/SunFlower.app
```

It picks up `apps/electron/assets/SunFlower.icns`, which is committed — so the
bundle has the pixel sunflower as its Finder icon out of a fresh clone. That
file is generated from the art itself (`APP_ICON` in `src/shared/sunflower-pixels.ts`,
rasterised by the same `pixelArtPng` the tray uses); run
`pnpm --filter sunflower make-icon` after changing it. If the Finder still shows
the generic icon, that's its cache, not your build: `touch` the bundle, then
`killall Finder`.

Drag it wherever you like. Double-clicking it opens a terminal on `sunflower` —
so the flower still lives in a terminal, with its TUI, and **closing that
terminal window closes the flower.** That's the point of the bundle: it does not
contain Electron and is not a detached app. It finds your preferred terminal if
one is already running (Ghostty, iTerm, WezTerm, kitty), and falls back to
Terminal.app.

It's unsigned and un-notarised — it's built on your machine, for your machine —
so the first launch needs a right-click → **Open**. If a second instance is
launched while one is already running, the single-instance lock forwards the
request to the live one instead of starting a rival.

The global command is self-sufficient: launched from a fresh clone (no `node_modules` yet), it runs `pnpm install` itself and then builds, instead of erroring with "run `pnpm install` first".

### `requirements.txt` — one file, one command

The repo root carries a `requirements.txt`: the Python convention — one declarative file listing everything the project needs — adapted to the global project. Each `# name: value` line is a requirement (Node ≥ 18, pnpm, installed dependencies, the Electron build, Ollama reachable, a vision-capable model, the Whisper model), and every line is deliberately a `#` comment so a stray `pip install -r requirements.txt` installs nothing instead of grabbing random PyPI packages.

- `sunflower requirements` checks every line and prints what's missing, with the exact fix per line.
- `sunflower requirements --fix` also installs what it can by itself: `pnpm install`, the esbuild build, pulling the Ollama model (with the same progress bar as `sunflower models --pull`).

It exits 0 when everything required is satisfied, 1 otherwise — usable as a preflight in scripts. Soft requirements (the build, the Whisper model) don't fail the check: sunflower handles those itself on launch. Entries declared `optional` (the cloud API keys — Eleven Labs, Anthropic, Wispr Flow — which soften the experience but break the fully-local point) are checked against their environment variables (`ELEVENLABS_API_KEY`, …) and never fail the check when unset.

Requirements: [Ollama](https://ollama.com) running (`ollama serve`) with a **vision-capable** model pulled. The default is `qwen3-vl:8b`; if it's absent, sunflower automatically uses the first local model with the `vision` capability. The Whisper model (`ggml-small-q5_1`, ~190 MB) downloads once on first launch into `~/Library/Application Support/sunflower/models/`.

macOS permissions (requested during onboarding, all grants go to the Electron binary): microphone, accessibility (global ⌃ ⌥ hotkey), screen recording. Config lives in `~/Library/Application Support/sunflower/config.json` (`ollamaHost`, `ollamaModel`, `whisperModel`); `OLLAMA_HOST` env var overrides the host. Sunflower's own windows are excluded from its screenshots via content protection.

Screen recording has a macOS quirk: its Settings pane only lists an app *after* the app has attempted a capture (there is no "+" button). Sunflower's first "grant" click triggers that attempt so the app registers itself and the system prompt appears; a second click opens the now-populated Settings pane. In dev the entry is named **Electron** (grants go to the Electron binary). After you tick the box, macOS offers to "Quit & Reopen" — choose **Later** and rerun `npm start` yourself, because the auto-relaunch starts a bare Electron without sunflower's app path. The grant survives the relaunch.
