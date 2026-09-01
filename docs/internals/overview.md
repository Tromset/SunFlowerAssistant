# Overview

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [guide: overview](../guide/overview.md)

Sunflower is a macOS screen companion. It lives in your menu bar, watches your
screen when you hold `⌃ ⌥` (Control + Option), and answers out loud. The model
doing the thinking runs on your own machine through
[Ollama](https://ollama.com) — no model provider, no per-token bill, no
screenshots leaving your Mac.

The repository contains **two implementations** of the same product, plus a
backend that only one of them uses:

| App | Path | Status | Inference | Transcription | Speech |
| --- | --- | --- | --- | --- | --- |
| **`sunflower`** (Electron) | `apps/electron` | **What actually runs** | local Ollama | local whisper.cpp (Metal) | macOS system voice |
| `Glide` (Swift/AppKit) | `apps/macos` | Earlier prototype, kept for reference | local Ollama, *via* the Worker | AssemblyAI (hosted) | Gradium (hosted) |
| `server` (Hono / Cloudflare Worker) | `apps/server` | Backend for the Swift app only | proxies local Ollama | issues AssemblyAI tokens | proxies Gradium |

Sunflower started as a fork of [Glide](https://github.com/shujanshaikh/glide),
which itself started as a clone of
[Clicky](https://github.com/farzaa/clicky). This version replaces the
hosted-model backend with local inference.

> **Read this first:** unless a section says otherwise, "Sunflower" in this
> document means the **Electron app** (`apps/electron`) — the one that runs
> 100 % locally with no server, no auth and no API keys. The Swift app and the
> Worker are documented separately at the end.

---

## What It Does

You hold a push-to-talk key (`⌃ ⌥`) and talk. Sunflower captures the screen
your cursor is on, sends the image plus your transcript to a local vision
model, streams the answer back, speaks it out loud, and can point at things on
screen with an on-screen bracket frame.

### Core features

| Feature | What it is | Lives in |
| --- | --- | --- |
| **Push-to-talk voice interface** | Hold `⌃ ⌥`, talk, release. Global hook via `uiohook-napi`. | `main/hotkey.ts` |
| **Screen capture & vision analysis** | JPEG of the display under the cursor, sent to a local vision model. | `main/screenshot.ts`, `main/ollama.ts` |
| **Cursor-following companion** | Pixel-art sunflower that follows the cursor with a speech bubble. | `main/windows/companion.ts`, `renderer/companion/` |
| **Screen pointing** | The model returns `[POINT:x1,y1,x2,y2]`; an orange bracket frame sizes itself to that element. | `main/guide-parser.ts`, `main/windows/pointer.ts` |
| **Guide mode** | Multi-step how-to plans (`[STEP:…]`) executed deterministically, no model calls between steps. | `main/guide-runner.ts` |
| **Terminal UI** | The launching terminal becomes a first-class interface: pixel banner, mode badge, slash commands. | `main/tui.ts`, `main/tui-pixel.ts`, `main/tui-ansi.ts` |
| **Sunflower-Code** | A local coding harness: 4 modes, 7 tools, 3 permission levels, and a context that renews itself without losing the task. | `main/code/`, `shared/code.ts` |
| **Sunflower Work** | An errand runner that drives mouse and keyboard while you're away. Opt-in. | `main/work/` |
| **The orb** | Right-edge badge showing the busy Code session or Work run. | `main/windows/orb.ts` |
| **Moods** | The flower gives itself an accessory matching the frontmost app. Event-driven, local. | `main/activity.ts`, `shared/activity.ts` |
| **Dock mode** | Pin the companion to a corner instead of chasing the cursor. | `main/windows/companion.ts` |
| **Watchdog** | Per-process CPU/RSS samples appended to a rotated JSONL log. | `main/watchdog.ts` |

## License

MIT — see [LICENSE](../../LICENSE).
