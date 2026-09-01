# File reference

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: architecture](architecture.md)

### `apps/electron/src/main`

| File | Responsibility |
| --- | --- |
| `index.ts` | wiring: IPC handlers, windows, tray, hotkey, lifecycle, `routeToCode()`, `shutdownEverything()` |
| `state-machine.ts` | the voice/typed session orchestrator |
| `ollama.ts` | `/api/tags`, `/api/ps`, streamed `/api/chat`, warm-up, context budget, `<think>` stripping |
| `stt.ts` | whisper.cpp: model download, load, resample, transcribe |
| `screenshot.ts` | `captureScreenAtCursor()` |
| `guide-parser.ts` | streaming marker extraction + coordinate normalisation |
| `guide-runner.ts` | deterministic guide execution |
| `point-verifier.ts` | DOM-first, vision-second pointing refinement |
| `dom-locator.ts` | JXA page-JS injection → interactive elements in screen points |
| `activity.ts` | event-driven frontmost app / tab URL detection |
| `presence.ts` | real-vs-synthetic input tracking |
| `hotkey.ts` | uiohook: `⌃⌥`, global clicks, backoff retry |
| `permissions.ts` | macOS permission status and requests |
| `config-store.ts` | atomic JSON config |
| `shell-guard.ts` | shared destructive-command blacklist |
| `watchdog.ts` | CPU/RSS JSONL sampler |
| `tray.ts`, `pixel-png.ts` | menu-bar icon (pixel art → PNG, 1× and 2×) |
| `tui.ts`, `tui-pixel.ts`, `tui-ansi.ts` | terminal UI |
| `claude/index.ts`, `claude/hooks.ts`, `claude/spool.ts`, `claude/store.ts` | the Claude Code bridge |
| `code/session.ts`, `code/tools.ts`, `code/transcript.ts` | Sunflower-Code |
| `work/runner.ts`, `work/store.ts`, `work/clicker.ts` | Sunflower Work |
| `windows/*.ts` | one module per surface + `common.ts` overlay factory |

### `apps/electron/src/shared`

Pure modules, no `electron`, no `node` — shared main ↔ renderer:

`state.ts` (phases, poses, permissions, `PanelData`) · `ipc.ts` (`CH` +
`SunflowerBridge`) · `config-schema.ts` · `code.ts` (modes, tools, gates,
bounds, transcript types) · `work.ts` (statuses, actions, settings + clamping) ·
`claude.ts` (Claude Code task states, hook events, payload parsing) ·
`orb.ts` (what the right-edge badge shows) · `activity.ts` (families,
classification) · `diff.ts` (bounded LCS) · `sunflower-pixels.ts` (all pixel
art: poses, moods, brackets, menu-bar icon, bee, field).

### `apps/electron/src/renderer`

`island/` (status + mic capture + `capture-worklet.ts`) · `companion/`
(flower, bubble, `tts.ts`) · `panel/` · `pointer/` · `onboarding/` ·
`orb/` · `work/` · `code/` · `shared/` (design tokens: colors, spacing,
typography, effects, fonts + Newsreader woff2, `base.css`, `dev-stub.ts`).
