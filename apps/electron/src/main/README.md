# Main process

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Electron main process (Node): session orchestration, pipelines, windows, tray, TUI, harnesses.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`claude/`](claude/README.md) | The Claude Code bridge: hooks, spool, session store |
| [`code/`](code/README.md) | Sunflower-Code — the coding harness |
| [`windows/`](windows/README.md) | One module per window surface + the shared overlay factory |
| [`work/`](work/README.md) | Sunflower Work — the errand runner |

## Files

| File | Purpose |
| --- | --- |
| [`index.ts`](index.ts) | Entry point: IPC handlers, windows, tray, hotkey, lifecycle, `routeToCode()`, `shutdownEverything()` |
| [`state-machine.ts`](state-machine.ts) | The voice/typed session orchestrator: idle → listen → think → answer → guide |
| [`ollama.ts`](ollama.ts) | Ollama client: `/api/tags`, `/api/ps`, streamed `/api/chat`, warm-up, context budget, `<think>` stripping |
| [`stt.ts`](stt.ts) | whisper.cpp: model download, load, resample, transcribe |
| [`screenshot.ts`](screenshot.ts) | `captureScreenAtCursor()` — JPEG of the display under the cursor |
| [`guide-parser.ts`](guide-parser.ts) | Streaming `[POINT]`/`[STEP]`/`[WORK]` marker extraction + coordinate normalisation |
| [`guide-runner.ts`](guide-runner.ts) | Deterministic guide execution: advances steps via proximity and clicks |
| [`point-verifier.ts`](point-verifier.ts) | DOM-first, vision-second pointing refinement |
| [`dom-locator.ts`](dom-locator.ts) | Reads the frontmost browser's DOM to snap pointer targets to real elements |
| [`activity.ts`](activity.ts) | Event-driven frontmost app / tab URL detection for moods |
| [`presence.ts`](presence.ts) | Real-vs-synthetic input tracking (idle detection, clicker suppression) |
| [`hotkey.ts`](hotkey.ts) | uiohook global hooks: `⌃⌥` push-to-talk, clicks, backoff retry |
| [`permissions.ts`](permissions.ts) | macOS permission status and requests (mic, accessibility, screen) |
| [`config-store.ts`](config-store.ts) | Atomic JSON config in userData (`config.json`) |
| [`shell-guard.ts`](shell-guard.ts) | Shared destructive-shell-command blacklist |
| [`watchdog.ts`](watchdog.ts) | Per-process CPU/RSS JSONL sampler |
| [`tray.ts`](tray.ts) | Menu-bar tray icon and context menu |
| [`pixel-png.ts`](pixel-png.ts) | Pixel art → PNG buffers for the tray (1× and 2×) |
| [`tui.ts`](tui.ts) | Interactive terminal UI: prompt, stream, pickers, slash commands |
| [`tui-pixel.ts`](tui-pixel.ts) | Renders shared pixel art as half-block truecolor terminal lines |
| [`tui-ansi.ts`](tui-ansi.ts) | ANSI colour, box-drawing and visible-width helpers |
| [`tui-theme.ts`](tui-theme.ts) | TUI role labels, block wordmark font, branding |

## When to read what

| Question | Read |
| --- | --- |
| Where are IPC handlers and app wiring? | [`index.ts`](index.ts) |
| How does a voice session flow? | [`state-machine.ts`](state-machine.ts) |
| How is Ollama called and kept warm? | [`ollama.ts`](ollama.ts) |
| How is speech transcribed locally? | [`stt.ts`](stt.ts) |
| How are pointing/guide markers parsed? | [`guide-parser.ts`](guide-parser.ts) |
| How is the coding harness implemented? | [`code/README.md`](code/README.md) |
| How does the errand runner work? | [`work/README.md`](work/README.md) |
| How does the Claude Code bridge work? | [`claude/README.md`](claude/README.md) |
| Where are windows created? | [`windows/README.md`](windows/README.md) |
| How does the terminal UI render? | [`tui.ts`](tui.ts) |
