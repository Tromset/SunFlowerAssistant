# Sunflower

Sunflower is a macOS screen companion that runs on **local models**. It lives in your menu bar, sees your screen, and answers out loud — and the model doing the thinking runs on your own machine through [Ollama](https://ollama.com). No model provider, no per-token bill, no screenshots leaving your Mac.

Sunflower started as a fork of [Glide](https://github.com/shujanshaikh/glide), which itself started as a clone of [Clicky](https://github.com/farzaa/clicky) by [Farza](https://x.com/FarzaTV). This version replaces the hosted-model backend with local inference.

## What it does

You hold a push-to-talk key and talk. Sunflower captures your screen, sends the image plus your transcript to a local vision model, streams the answer back, speaks it out loud, and can point at things on screen with an on-screen cursor. If you connect external apps through Composio, it can also take action in them.

The backend is a small Hono API running on a Cloudflare Worker. It handles:

- authenticated chat streaming against a **local Ollama** instance (native `/api/chat`)
- listing the models you have pulled locally, with their capabilities
- AssemblyAI realtime transcription token generation
- Gradium text-to-speech proxying
- Composio-powered integrations for connected apps (Notion, Google Docs, Gmail, Slack, GitHub, …)
- Clerk authentication for the macOS app and the server routes

### What runs locally, and what doesn't

Only the **language model** is local. Transcription (AssemblyAI), speech (Gradium), auth (Clerk) and app integrations (Composio) are still hosted services, and each is optional in the sense that the feature it powers simply won't work without its key.

> **Telemetry is opt-in and off by default:** the macOS app inherited the upstream project's PostHog analytics, but it's now gated behind an explicit "Share usage data, including message content" toggle (Home tab of the menu-bar panel), backed by the `analyticsOptIn` UserDefaults key. Until you turn it on, `apps/macos/Glide/GlideAnalytics.swift` never initialises PostHog and never sends an event — every capture call site re-checks the flag, not just setup. When enabled, it shares: app-opened/onboarding/permission-granted milestones, push-to-talk start/stop, your transcribed message and the AI's full response text (each with a character count), which on-screen element got pointed at, and response/TTS error messages — attributed to PostHog's auto-generated anonymous distinct ID, never to your identity. The onboarding flow's old behavior of POSTing the email you enter to the upstream author's personal third-party form endpoint, and of calling PostHog's `identify()` with that raw email, have both been removed entirely — sending PII was never something the opt-in should have gated in the first place, so it's just gone. The PostHog project API key itself is no longer hardcoded: it lives in a gitignored `apps/macos/Config.xcconfig` (see "5. Configure and run the macOS app" below), and if you leave it blank, analytics is a hard no-op — PostHog is never initialised, opt-in toggle or not.

## Architecture

```txt
apps/
  electron/ Electron screen companion "sunflower" — fully local (Whisper + Ollama)
  macos/    Native Swift/AppKit menu bar app
  server/   Hono Cloudflare Worker API
packages/
  config/   Shared TypeScript config
```

The app owns the macOS experience: menu bar UI, push-to-talk, screen capture, voice playback, cursor pointing, auth callbacks. The Worker owns authenticated API access, model streaming, transcription tokens, TTS proxying, and tool integrations.

The app never picks a model — it sends messages and the server decides which Ollama model to use. That keeps model configuration in one place (`OLLAMA_MODEL`) and means you can change models without rebuilding the app.

> **Note on naming:** the Xcode project, scheme and target are still named `Glide`, and the app's URL scheme is still `glide://`. Renaming them is cosmetic and risks breaking the Clerk and Composio redirect flows, so it hasn't been done. Wherever this README says `Glide`, it means the Xcode target.

## Electron app — `sunflower` (100 % local)

`apps/electron` is a second, fully local implementation of the companion, built from the Claude Design prototype in `app-electron-avec-tournesol-local/`. Unlike the Swift app + Worker pair, it needs **no server, no Clerk, no API keys**: push-to-talk (hold ⌃ ⌥) → mic capture → **local Whisper** transcription (whisper.cpp, Metal) → screenshot → **local Ollama** vision model → streamed answer in a speech bubble next to a pixel-art sunflower that follows your cursor, spoken aloud with the macOS system voice. English UI, in the app's black-and-yellow theme.

Surfaces: a status island under the menu-bar notch, the cursor-following sunflower companion with its speech bubble, an orange pointing overlay that frames the one element the model points at — sized to that element's bounding box (see "Pointing" below), a menu-bar tray panel (live permissions, model status, moods, work, quit), a dedicated **Sunflower Work** window, a dedicated **Sunflower-Code** window, and a 3-step onboarding on first launch.

### Screenshots

The onboarding walks through welcome, permissions, and the local-model check — in the same black-and-yellow theme as the running app:

| Welcome | Permissions | Local model |
| --- | --- | --- |
| ![Onboarding welcome step](apps/electron/docs/screenshots/onboarding-welcome.png) | ![Onboarding permissions step](apps/electron/docs/screenshots/onboarding-permissions.png) | ![Onboarding local-model step](apps/electron/docs/screenshots/onboarding-model.png) |

The menu-bar panel shows live permission, model, and voice status:

![Menu-bar panel](apps/electron/docs/screenshots/panel.png)

The status island sits under the notch while sunflower listens and answers, and the cursor-following companion streams the reply in a speech bubble:

| Listening | Answering | Companion |
| --- | --- | --- |
| ![Island listening state](apps/electron/docs/screenshots/island-listening.png) | ![Island answering state](apps/electron/docs/screenshots/island-answering.png) | ![Cursor companion with speech bubble](apps/electron/docs/screenshots/companion.png) |

### Run it

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

```bash
pnpm --filter sunflower make-app     # writes apps/electron/dist-app/SunFlower.app
```

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

### The terminal

When launched from a terminal (`npm start` or `sunflower`), sunflower turns it into a first-class interface — and it's the same black-and-yellow, same pixel sunflower as the windows, drawn in the terminal itself:

- **The startup banner draws the real sunflower.** Not ASCII art approximating it: the very pixel art the app renders as SVG (`shared/sunflower-pixels.ts`) is rasterised into half-block characters (`▀`, one glyph carrying two pixels, each doubled horizontally so the pixels come out square) in 24-bit colour, next to a rounded status card (`╭─ ✿ sunflower ─── v0.1.0 ─╮`) listing model, Ollama host, voice, hotkey, Sunflower-Code and Sunflower Work. Without truecolor it degrades to shape-only blocks; without a TTY, to the historical `[sunflower]` log lines.
- **The layout is [Ollama-Code](https://github.com/Tromset/Ollama-Code)'s, repainted in sunflower's colours.** A block-font `SUNFLOWER` wordmark beside the pixel flower, then the status card. Below that, every line carries a **three-character role column** — `you`, `sun`, `sys`, `run`, `err` — always the same width, always in the same place: that's what makes a stream mixing questions, answers, tool calls and notes scannable rather than something you have to decipher line by line.
- **A persistent bottom chrome**: a status bar (`sunflower · code · qwen3-vl:8b · effort medium · thinking…` on the left, `ctx 12,004/32,768 (37%)` on the right, green under 50 %, yellow past it, red past 75 %) sitting directly above the `❯` input line. Both are the readline prompt, so they're redrawn when something changes and never on a timer.
- **There is no spinner.** Busy shows as `thinking…` in the status bar. That's straight from the original, and it also means the terminal has no recurring cost at all while you're not using it — the always-on rule in `CLAUDE.md`.
- **The live stream is bounded.** A long answer keeps only its tail on screen (`… (+12 earlier lines)` above it) so it can never push the bottom chrome off the terminal.
- **Slash commands**, in a card of their own under `/help`: `/mode`, `/model`, `/pull`, `/effort`, `/permission`, `/cd`, `/btw`, `/image`, `/init`, `/compact`, `/clear`, `/code`, `/sessions`, `/status`, `/work <chore>`, `/quit`.
- **`/model` with no argument opens a picker** — every model Ollama has on disk, with parameter size, quantization and disk size, the active one marked `● current`. `↑`/`↓` or `j`/`k` to move, `enter` to switch, `esc` to cancel; while it's open it swallows every keystroke, so nothing leaks into the input line. `/model <name>` switches directly but checks the name against what's actually installed first, and `/pull <name>` downloads one without leaving the prompt.
- **`/effort` sets how much time and effort goes into a task.** `/effort low|medium|high` picks a coherent set of generation budgets — tokens per turn, context window, turn ceiling — for all four surfaces at once (`shared/effort.ts`); `medium` is the default and reproduces the values that were previously hard-coded in four separate files, so it changes nothing until you ask. `/effort 20m` adds a wall-clock cap per task, `/effort off` removes it. `/effort` alone reads both back.
- **`/btw <note>`** slips a note into the context without triggering a reply — a correction you want the model to have next turn, not a question. **`/image <path>`** attaches a picture to your next message, **`/init`** writes a `SUNFLOWER.md` describing the project, **`/compact`** renews the context now instead of waiting for the budget.
- **`ctrl+L` folds and unfolds the thinking block**, mid-stream included; folded it reads `[thinking · 14 lines]`.
- **Type a question at the `❯` prompt** — it takes a screenshot at your cursor and runs the exact same pipeline as voice: the answer streams into the terminal *and* into the companion bubble with speech. Typing works even while whisper is still downloading.
- Voice sessions render live too: `listening…`, `looking at your screen…`, your transcribed question, a spinner while the model thinks, then the streamed answer with its duration.
- On a cold start the spinner says `waking the model…` instead of failing — sunflower preloads the model when the app launches and again the moment you start speaking, and allows up to ~3 minutes for the first token of a cold load.
- **Every 10 000 tokens of context, a fresh chat starts automatically.** The Ollama runner survives from one question to the next (`keep_alive` + prompt cache), and with small local vision models that accumulated state degrades answers over a long session — early questions read the screen perfectly, later ones start hallucinating. Sunflower counts the tokens each answer really consumed (as reported by Ollama) and, past 10k, prints `✦ … starting a fresh chat`, unloads the model — discarding all of its state — and preloads it again in the background while you read the answer.
- **Native whisper.cpp/Metal logs never reach the terminal.** whisper.cpp re-initialises its state (Metal context included) on every transcription and logs the whole process to stderr — dozens of `whisper_*` / `ggml_*` lines per question. The launcher filters them out into `~/Library/Application Support/sunflower/logs/native.log` (rotated at 5 MB) so the terminal only shows the dialogue; anything else written to stderr (real errors) still comes through.
- **Ctrl+C** interrupts the current answer, the current Sunflower-Code turn *and* any work run. It never quits — that's `ctrl+D` or `/quit`, same as the original. Set `SUNFLOWER_DEBUG=1` for full error details and the raw, unfiltered native logs.
- **Closing the terminal closes sunflower.** It listens for `stdin` closing and for `SIGHUP` — events, not a poll of the parent process — and only when it was actually launched from a TTY.
- Without a TTY (packaged app, redirected output) all of this degrades to plain `[sunflower]` log lines — nothing else changes.

### Sunflower-Code — the coding harness

The terminal isn't only a question box. `/mode code` (or `chat`, `vision`, `plan`) routes **everything you type** to **Sunflower-Code**, a port of [Ollama-Code](https://github.com/Tromset/Ollama-Code)'s infrastructure living inside sunflower and running against the same local Ollama. There is exactly one entry point — `routeToCode()` in `main/index.ts` — so there is exactly one place to look to know where a message went.

**Four modes**, same names as the original: `code` (the full workshop), `chat` (no tools at all), `vision` (same as code, with a screenshot of your screen attached to the message), `plan` (read-only: investigate, then write out the plan).

**Seven tools**, all confined to one project folder — `read_file`, `write_file`, `edit_file`, `move_file`, `list_files`, `search`, `bash`. An absolute path, a `..`, or a filename that looks like a secret (`.env`, `.npmrc`, `id_rsa`…) is refused before anything is opened; `bash` runs with its working directory locked to that folder and goes through a non-bypassable blacklist (`main/shell-guard.ts` — `rm -rf`, `sudo`, force pushes, piping downloads into a shell…). `/cd` moves the folder.

**Three permission levels**, `/permission`:

| Level | Reads | Writes and shell |
| --- | --- | --- |
| `plan` | free | refused outright |
| `normal` *(default)* | free | each one waits for `y`, `n` or `a` at the prompt |
| `yolo` | free | no questions asked |

The mode can restrict further but never widen: `plan` mode is read-only even under `yolo`, and `chat` exposes no tools at all whatever the level.

`a` at an approval prompt means **always allow this exact action** — same tool, same arguments — for the rest of the session. It generalises nothing: approving `bash npm test` once and for all does not approve `bash`, and certainly not `bash rm -rf`. The rule is dropped when you `/clear`, change permission level, or change project folder.

**Two tool dialects, one code path.** Small local models are not equal in front of function calling, so Sunflower-Code asks Ollama (`/api/show`) whether the model advertises `tools`. If it does, the native tool interface is used. If it doesn't, the prompt describes a text protocol instead — one fenced ```tool block holding `{"name": …, "args": {…}}` — and the parser turns it into the same call object. Nothing downstream knows which one served.

**The context renews itself.** Past a token budget the session is *compacted*: the original request, the tools already run and the last answer are folded into a short local summary (no extra model round-trip), and the conversation restarts from a fresh window. That's what makes a long refactor survivable on an 8B model. If the model asks for more tool calls than a turn allows, it's told so explicitly rather than silently truncated.

**The Sunflower-Code app.** The harness now has a window of its own, the same kind Sunflower Work has — `code ↗` in the menu-bar panel, `sunflower code` from a terminal, or `/code` at the prompt. It is **the same session as the terminal's**, not a second one: a question typed at `code ❯` appears in the window as it streams, a message sent from the window comes out in the terminal, and `/mode`, `/permission` and `/cd` move the app's controls the moment you type them (and the other way round). One conversation, two places to watch it — which is also why the composer greys out while a turn is in flight: one turn at a time is the truth, not a limitation of the window.

Three columns, and they say what a coding harness actually is:

- **left — what it may do**: mode and permission as pills, the project folder, and the live gate for all seven tools (`free` / `asks you` / `refused`, greyed out when the mode doesn't expose them at all). Not a restatement of the table above — the same `gateFor`/`toolsFor` the harness itself calls, so `plan` under `yolo` visibly closes every write. Under it, the turn and token meters against the real ceilings (24 turns, 12k tokens) and the compaction count.
- **middle — what it is saying**: the conversation, with the answer streaming into a live bubble, tool calls inline (`▸ read_file src/x.ts` → `✓ 42 lines · … 12ms`), raw command output in its own block, and a rule where the context renewed itself. Tabs split out the bare tool-call list and a plain terminal view. A tool waiting for permission raises a banner **pinned above the composer** so it cannot scroll out of sight — with, for an `edit_file`, the diff of what it is about to do, *before* you allow it. Answer in the terminal instead and the banner clears itself; click in the window and the terminal's prompt comes back. A click that lands on an approval already settled elsewhere does nothing, rather than answering the next one.
- **right — what it changed**: every file written this session, newest first, with a real before/after diff. `write_file` re-reads the file just before overwriting it and `edit_file` already held both sides, so this costs one `readFileSync` and nothing crosses the IPC boundary but the diff itself — never the file contents.

Closing the window hides it; the session keeps running in the terminal and reopening finds the whole transcript, including everything that happened while it was shut. The window costs nothing at rest: no timer, no poll, no `requestAnimationFrame` — every pixel of it moves because an event arrived, and the "thinking" pulse is a CSS animation (see the always-on budget in `CLAUDE.md`).

### Pointing

When pointing at one element genuinely helps the answer, the model ends it with that element's **bounding box** — `[POINT:x1,y1,x2,y2]`, four integers from 0 to 1000 relative to the screen image, the grounding format `qwen3-vl` is natively trained on — and the orange bracket frame **sizes itself to the element** (constant-thickness pixel-art brackets, padded a little, clamped between 60×48 px and 70 % of the screen, and always fully on-screen). Guide steps carry the same boxes: the frame wraps each step's target and the step advances as soon as the cursor enters the box, not just a fixed radius around its center; the companion parks itself clear of wide frames.

Because small local models don't all speak the same coordinate dialect, the parser normalizes whatever comes back: legacy two-number centers (`[POINT:50%,30%]`, shown with the default fixed frame), percentages, 0–1 fractions, and absolute pixels of the captured image are all accepted. What it refuses to do is guess: a marker it can't parse shows nothing (it used to be mangled into a corner), a box covering essentially the whole screen is discarded as noise instead of being drawn, and the prompt now instructs the model to skip the marker entirely when it isn't sure where the element is — no marker is better than a frame around a button that doesn't exist. `SUNFLOWER_DEBUG=1` logs every marker's raw text, the convention detected, and the final frame rectangle, so a bad pointing is diagnosable after the fact.

The single-element frame draws **immediately** from the model's own box — pointing is instant and never waits on a round-trip — and a **double check** then refines it in place, treating the first marker as a claim to improve rather than a gate the frame must clear first. Sunflower looks at which app is frontmost: if it's a browser (Safari or a Chromium — Chrome, Brave, Edge, Arc, Vivaldi, Opera) with "Allow JavaScript from Apple Events" enabled, it reads the page's actual HTML — the visible interactive elements (buttons, links, inputs, ARIA roles) with their exact on-screen boxes — and snaps the frame to the real element nearest the claimed spot, an element whose label appears in the answer being trusted over a merely-close one (`dom-locator.ts`). When no DOM is reachable, a second vision pass takes over instead: the screenshot is cropped to a zoom around the claimed box and the model corrects its own bounding box on that crop (`point-verifier.ts`). Either way the correction only moves the frame if it lands **while the frame is still on screen** — a refinement that resolves after the frame has faded is dropped rather than popping a box back up out of nowhere. Guide steps are different: their targets are DOM-snapped from a single snapshot **before** the step is drawn — visible-target steps only, so the guide's execution stays deterministic with no extra model calls between steps. Every fallback is silent and non-blocking: DOM unreadable, second pass timing out or answering `[MISS]`, and the model's original box simply stays as drawn. `SUNFLOWER_NO_DOUBLE_CHECK=1` skips the refinement entirely; with `SUNFLOWER_DEBUG=1` each correction logs its path and the `original → corrected` coordinates.

### Dock mode

Double-click the sunflower, flip the **companion** toggle (**roam** / **dock to corner**) in the menu-bar panel, or use the tray menu (**dock sunflower to corner** / **let sunflower roam**), to pin the companion in one spot instead of having it chase your cursor. Docked, it shrinks to a compact ~110×110 badge parked in the bottom-right corner of the display's work area, with a scaled-down speech bubble above it, so nothing floats over the middle of the screen while you're watching or sharing it. The mode is saved (`companionMode` in `config.json`) and restored on the next launch, and a docked companion re-pins itself to the corner if the display's resolution or scaling changes. The companion window is click-through everywhere except the flower itself — hovering it briefly makes the window interactive so the double-click can land, then releases the instant the cursor leaves, so it never eats a click meant for whatever's underneath.

This shipped alongside a pass on that same tracking loop, prompted by a "this app is heating up my Mac" report: instead of an unconditional 60 fps timer and an unconditional `setBounds` call, the companion now runs at ~30 fps while it's actually moving, drops to ~6 Hz after 3 seconds of cursor stillness, and stops the loop entirely while docked, hidden, or holding still — `setBounds` is skipped outright when the target position hasn't changed. Its decorative animations (the flower's sway, the blinking caret) pause the same way after 60 seconds of idle, and the mostly-hidden pointer overlay now lets Chromium throttle its background timers instead of being exempted like the always-visible island, companion, and orb windows.

That animation freeze was quietly broken again by the moods release and has been repaired: a displayed mood used to disarm the 60-second timer permanently, and the pause rule named four selectors by hand, so none of the dozen mood keyframes were covered by it. The rule is now a wildcard over everything the flower carries — the next decorative animation is covered without anyone remembering to add it — and the countdown measures real stillness (the companion window sees your mouse move) instead of time since the last state change, so a prop no longer freezes while you're sitting right there. The recurrence is the point: this is the same class of defect as the polling above, which is why `CLAUDE.md` now carries an always-on budget and `apps/electron/scripts/check-loops.mjs` fails the build on any undeclared recurring cost.

### Moods — a little prop for what you're doing

When the sunflower has nothing else to do, it gives itself an accessory that matches whatever app is in front of you: **headphones** on Deezer or Spotify, a **little laptop** on Cursor or VS Code, an **"AI" placard** on Claude, ChatGPT or Gemini, **popcorn** in front of YouTube or Netflix, a **plaid blanket** hunched over a screen in Figma or Premiere Pro, a **phone with messages flying out** on Snapchat or Discord, and the same phone with **wilted petals, a fallen one on the floor and a slow "zzz"** on TikTok or Instagram. Each is pixel art in the same grid and palette as the rest of the flower (`shared/sunflower-pixels.ts`), animated purely in CSS under a class the companion adds and removes — nothing loops outside its own mood.

Two rules keep it honest. **A mood only ever shows at idle**: the moment a question, a guide, a code session or a work run has something to say, the real pose wins and the prop disappears. And **it stays on the machine**: `main/activity.ts` classifies the frontmost app — plus the active tab's URL when that app is a scriptable browser — into one of seven families (`shared/activity.ts`) and throws the rest away. Nothing is written to disk, nothing is sent to the model, nothing leaves the Mac. It stops entirely while the companion is hidden, and for good if you untick **moods** in the panel (`moodsEnabled`). A browser on a site it doesn't recognise gets no prop rather than a wrong one.

**Nothing polls.** The first version of this asked System Events for the frontmost app every 4 seconds — a fresh `osascript` process ~900 times an hour, each one enumerating every application on the machine over Apple Events, on by default. It was the fourth time this repository shipped a "watch the environment continuously" loop and the fourth time it made a Mac hot; the whole story, and the check that now fails the build over it, are in `CLAUDE.md`. What replaced it: Electron subscribes to `NSWorkspaceDidActivateApplicationNotification` in-process (`systemPreferences.subscribeWorkspaceNotification`), so app switches *arrive* instead of being hunted for, and idle costs exactly nothing. macOS hands over the app's bundle id with the notification but not its localized name, so the name is read once per unseen bundle through `NSWorkspace` — no System Events, no Accessibility, no Automation prompt — and cached, which means returning to an app you've already used costs no process at all. The tab URL is the one thing with no notification behind it: it's re-read on **real input** (`presence.onRealInput`), at most once every 10 seconds, only while a scriptable browser is in front, and 1.2 s after the input so a click on a link has time to land. Since navigating requires a click or a keystroke, nothing is missed — and when you're not touching the machine, nothing runs. Without Accessibility granted there is no input signal, so the URL is simply the one from when you focused the browser; the moods still work, and there is still no polling.

### The menu-bar panel

The panel now **sizes its window to its own card**. It used to live in a fixed 620 px window: as soon as the card grew past it — a long list of sections — the bottom was cut off mid-pixel and both rounded corners went with it, which is exactly the "it doesn't end properly" you'd notice first. The renderer measures the card's natural height (chrome plus the scrolling view's content) and the window follows, clamped to the screen with room left under it for the shadow; past that clamp the view scrolls inside the card instead, so the corners are always drawn. **work ↗** in the tab row launches the Sunflower Work app, and the footer's **quit** is a real button now: it cancels the running errand, disposes the Sunflower-Code session, cuts the voice and closes the work window before the app exits — nothing is left running behind.

### Switching models — `sunflower-models`

A second, standalone CLI for browsing what's pulled locally and changing which model sunflower uses, without opening the app. It's registered as its own bin (`sunflower-models`, picked up by the same `npm link` above) and also reachable as a subcommand of the main CLI (`sunflower models …`), which dispatches to it before any Electron/build logic runs — no build needed either way.

- With no arguments it opens an interactive, arrow-key browser in the same black-and-yellow theme as the app: an **Installed** section (from Ollama's `GET /api/tags` — name, size, parameter count, active model marked) and a curated **Recommended** section — vision models (`qwen3-vl:8b`, `qwen2.5vl:3b`/`7b`, `llama3.2-vision:11b`, `moondream`, `llava:7b`/`13b`, `minicpm-v`) plus text models for the coding harness below (`qwen2.5-coder:7b`, `llama3.1:8b`, `deepseek-r1:7b`/`8b`).
- **Enter** on an installed model makes it active immediately; **Enter** on one you don't have yet pulls it via `POST /api/pull`, with a live progress bar, then offers to make it active.
- `sunflower models --list` — the same two sections as a plain table, no TTY required.
- `sunflower models --pull <model>` / `sunflower models --use <model>` — non-interactive pull / switch, for scripting.
- `sunflower models --help` — usage.

"Active" means the `ollamaModel` field in `~/Library/Application Support/sunflower/config.json` — the same file the app itself reads. The CLI rewrites just that field atomically (temp file + rename), leaving every other field in the file untouched. Any Ollama network failure prints the same `ollama serve` hint as the rest of sunflower and exits non-zero.

### The orb

While a Sunflower-Code session or a Sunflower Work run is busy, a small
pixel-sunflower **orb** docks to the right edge of the screen — the only sign
of life when neither app has a window open. Hovering it expands a status pill
that follows the real activity (`sunflower — turn 3/8 · thinking…`, `running
tools…`, `approval waiting for you`, `step 12`), and the ring animation only
plays while something is actually happening: a model call in flight or a tool
running. Waiting on *you* — an approval prompt, a paused errand — leaves the
disc lit but still. Dragging the orb up or down repositions it (the position is
remembered across restarts); a plain click opens whichever app the badge is
showing.

The orb costs nothing at rest. It has no timer of its own: it is recomputed
only when the code session or the work runner emits an event it already had to
emit, and it stays hidden until one of them is actually busy.

### Sunflower Work — the errand runner and its app

Sunflower can also drive your mouse and keyboard to finish a computer errand — "archive the newsletters," "close all these tabs," "empty the trash" — instead of just answering or narrating a guide. It's off by default: turn it on from the tray menu (**Enable Sunflower Work**), from the panel's *sunflower work* section, or from the work app itself (persisted as `sunflowerWorkEnabled`). Ask for something that reads as an errand rather than a question, and the model answers with a short acknowledgement plus an internal `[WORK: …]` marker (never shown or spoken) that hands the task to the work runner; `/work <chore>` at the CLI does the same thing directly; ask with it still off and sunflower just tells you where to flip the switch.

**The work app.** Clicking **work ↗** in the menu-bar panel (or *open Sunflower Work…* in the tray) launches a dedicated window — a real window, not an overlay, and excluded from sunflower's own screen captures so a run never ends up commenting on its own interface. Three columns:

- **left** — create a run, and the list of every agent with its live state (`queued`, `running`, `paused — the mac is yours`, `done`, `stopped`, `failed`, plus `waiting for you to leave` if you asked it to wait) and step count;
- **middle** — the selected run's **tool calls** (every gesture: what, where, why, when, grouped by context window) and its **terminal** (the same log the CLI prints, timestamped and colour-coded);
- **right** — a **chatbox** that reaches the running agent, and the limits (what happens when you use the mac, how long to wait before the first move, time budget, steps per run).

**It renews its own terminal.** This is what lets a run last hours on a local model. Each context window is capped in tokens and steps; when one fills up, the runner closes it, writes a handoff summary of the last steps, **unloads the Ollama runner so its accumulated state is actually discarded**, and opens a fresh window that starts from that summary. The work app shows the seams (`terminal 2 · 4 800 tokens`) instead of hiding them. The time budget defaults to 2 hours and can be set to *no limit*.

**The chatbox is not decoration.** Anything you write while a run is in flight is handed to the model on its next turn, above its own plan — "actually, skip the promos" lands before the next click.

**It starts right away.** You don't have to leave your desk for a run to begin — hand over a chore and the first gesture goes out within the second. What makes that liveable isn't waiting, it's **giving the cursor back**: the runner watches the same global input hook as the push-to-talk hotkey, and the instant it sees a real keystroke or mouse movement, no further gesture is posted, the session shows `paused — the mac is yours`, and it picks up on its own about two seconds after you stop. If you started typing while the model was still thinking, the step it had decided on is *thrown away* rather than clicked — the screenshot behind it is stale, and clicking at coordinates from a screen that has moved is exactly the mistake worth refusing. Nothing is ever touched while your hands are on the machine; it just no longer costs you the run.

Two knobs in the work app, both in *limits*. **When you use the mac**: *pause, then pick up again* (the default) or *stop the run* — the old behaviour, an immediate abort with "you came back — hands off, all yours". And **wait for you to leave first**, `0` by default, meaning start now; set it to 20 s and you get the original flow back, including the quiet give-up if you haven't stepped away within 2 minutes. Everything else that stops a run is untouched: the push-to-talk hotkey, the toggle, quitting, the step and time budgets. It's macOS-only, and refuses to start at all without the Accessibility permission that input hook depends on, rather than drive blind — pausing needs that same input stream to know when to stand down.

**Nothing polls, here either.** The old version spun a `while (idleMs() < required) await sleep(1000)` loop for the whole wait — a wake-up every second, just to ask a question that has an event behind it. Both the wait and the resume now hang off `presence.onRealInput`: one timer, armed once, re-armed only when you actually touch something. When nobody is at the machine it doesn't wake up at all. Same rule as the rest of the app (`CLAUDE.md`).

Then it loops: screenshot → one turn of the local vision model, constrained to reply with exactly one JSON action (`click`, `double-click`, `type`, `key`, `wait`, or `done` to end the run) → a real CGEvent/System Events call via `osascript` (no extra dependency) → a 1.5–2.5 second settle pause → repeat, feeding the model a running log of what it's already done. Scrolling goes through `key` (`pagedown` / `pageup`): a reliable synthetic scroll wheel would mean a native binary, a key press works everywhere and is just as cancellable. It stays bounded on every side — the step and time budgets above, 90 seconds per model turn, and it gives up if the model answers off-format three times in a row — and its own synthetic input is tagged so the presence guard doesn't mistake it for you — that tagging matters more now than it did: an untagged click would read as "the user is back", pause the run, and the run would be waiting on itself. The suppression is per input family, so a real mouse movement still stands the flower down in the middle of a long synthetic keystroke burst. Several errands can be queued; they run one at a time, because they share one mouse. Progress narrates on the status island (`looking at the screen (step 3)…`, each step's short reasoning) and ends with a system notification saying done, stopped, or failed; flipping the toggle off cancels any run in progress immediately. The prompt keeps it conservative by design: never open an app it can't see on screen, never touch system settings, never type a password.

### Diagnostics: the watchdog

The Electron app runs a lightweight watchdog alongside everything else: every 5 seconds it samples CPU and memory per-process (`app.getAppMetrics()`) and appends a JSON line to `~/Library/Application Support/sunflower/watchdog/watchdog-YYYY-MM-DD.jsonl` — one file per day, pruned automatically to a few days of history and a few megabytes total. If total CPU usage stays above ~300% (roughly three full cores) for more than 30 seconds it also logs a `warn` line naming every running process, so a "the app is heating up my Mac" report comes with an actual trail — screen capture, whisper.cpp, a stray `BrowserWindow`, Ollama running away with the GPU — instead of a guess. The watchdog never throws, never blocks the app on disk I/O, and never keeps the process alive at quit.

It has a known blind spot, worth stating because it cost a release: a "300 % for 30 seconds" threshold sees a runaway model, but not a steady drip of short-lived child processes. The mood poll forked an `osascript` every 4 seconds for days without ever tripping a single `warn` line. That gap is what the static budget check (`apps/electron/scripts/check-loops.mjs`, and `CLAUDE.md`) exists to cover: the watchdog reports what is already burning, the check refuses to let it be written.

## Prerequisites

- macOS with Xcode installed
- Node.js and pnpm
- [Ollama](https://ollama.com) running locally
- A Clerk application (required — every API route is authenticated)
- Optional, per feature: AssemblyAI (transcription), Gradium (speech), Composio (app integrations)

## 1. Install Ollama and pull a model

```bash
brew install ollama
ollama serve
```

Or download the app from [ollama.com/download](https://ollama.com/download).

Then pull a model. Sunflower's default is `qwen3-vl:8b`:

```bash
ollama pull qwen3-vl:8b
```

**Pick a model with the right capabilities.** Sunflower sends screenshots, so you want a model with `vision`. If you plan to use the Composio integrations, you also need `tools`:

| Model | Vision | Tools | Notes |
| --- | --- | --- | --- |
| `qwen3-vl:8b` | ✅ | ✅ | Default. Good balance of quality and speed. |
| `qwen3-vl:32b` | ✅ | ✅ | Better answers, needs a lot more RAM. |
| `llama3.2-vision` | ✅ | ❌ | Vision only — no app integrations. |
| `gemma3` | ✅ | ❌ | Vision only — no app integrations. |
| `minicpm-v` | ✅ | ❌ | Small and fast, vision only. |

Check what a model actually supports:

```bash
ollama show qwen3-vl:8b
```

A model without `vision` will not be able to see your screen. A model without `tools` will ignore the connected-app integrations.

## 2. Install dependencies

```bash
pnpm install
```

## 3. Configure the Worker

Create `apps/server/.dev.vars`:

```bash
# Required — every route is behind Clerk
CLERK_SECRET_KEY=...
CLERK_PUBLISHABLE_KEY=...

# Optional, per feature
ASSEMBLYAI_API_KEY=...   # /transcribe-token
GRADIUM_API_KEY=...      # /tts
COMPOSIO_API_KEY=...     # app integrations

# Optional TTS tuning — defaults live in wrangler.toml
GRADIUM_TTS_MODEL=default
GRADIUM_TTS_VOICE_ID=...

# Ollama — defaults also live in wrangler.toml
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3-vl:8b
OLLAMA_NUM_CTX=32768
```

The Ollama settings are plain vars, not secrets, so they are already in `apps/server/wrangler.toml` with the defaults above. Only override them in `.dev.vars` if you want different values locally.

### About `OLLAMA_NUM_CTX`

Ollama defaults to a 4096-token context window. A screenshot plus Sunflower's own instructions blows straight through that, and the result is silent truncation — the model behaves as if it never saw part of your screen. Sunflower therefore always sends an explicit `num_ctx`, defaulting to 32768.

If you have limited RAM, lower it (`16384`). If you send large screenshots or hold long conversations, raise it — but the ceiling is whatever the model itself supports, and a larger window costs memory.

## 4. Run the Worker

```bash
pnpm run dev:server
```

It listens on `http://localhost:8787`.

## 5. Configure and run the macOS app

The app reads these values from Xcode build settings, injected into `apps/macos/Glide/Info.plist`:

```txt
GLIDE_SERVER_BASE_URL   # e.g. http://localhost:8787
CLERK_PUBLISHABLE_KEY   # must match the Clerk app the server uses
CLERK_CALLBACK_SCHEME   # usually glide
CLERK_REDIRECT_URL      # usually glide://callback
```

If `GLIDE_SERVER_BASE_URL` is unset, the app falls back to `http://localhost:8787`.

`CLERK_PUBLISHABLE_KEY` and `DEVELOPMENT_TEAM` (your Apple Developer Team ID, used for code signing) are **not** committed — they live in a gitignored `apps/macos/Config.xcconfig` that the `Glide` target's Debug and Release build configurations load as their base configuration. Without that file the build fails immediately (`Config.xcconfig: No such file or directory`) instead of silently signing with, or authenticating against, someone else's credentials.

Set it up:

```bash
cd apps/macos
cp Config.xcconfig.example Config.xcconfig
```

Then edit `Config.xcconfig` and fill in:

- `CLERK_PUBLISHABLE_KEY` — the publishable key from the same Clerk application as your server's `CLERK_SECRET_KEY`. Using a different Clerk app's key means every server call 401s.
- `DEVELOPMENT_TEAM` — your Apple Developer Team ID (Signing & Capabilities > Team in Xcode, or [developer.apple.com/account](https://developer.apple.com/account) under Membership). A free personal team works for local development.
- `POSTHOG_API_KEY` — optional, and only relevant if you want the opt-in analytics described above to actually go somewhere. Leave it blank to keep analytics a hard no-op regardless of the in-app toggle, or fill in your own PostHog project's key to collect those events yourself.

`Config.xcconfig.example` documents each key, including the optional `GLIDE_SERVER_BASE_URL` override.

Then:

```bash
open apps/macos/Glide.xcodeproj
```

1. Select the `Glide` scheme.
2. Confirm your signing team under Signing & Capabilities matches `DEVELOPMENT_TEAM`.
3. Cmd + R.

Sunflower appears in the menu bar. Sign in, grant the screen-recording and microphone permissions it asks for, and hold your push-to-talk key.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/chat` | Streaming chat. Accepts an optional `model` to override `OLLAMA_MODEL` for that request. |
| `GET` | `/models` | Models pulled locally, with capabilities and the configured default. |
| `POST` | `/tts` | Gradium text-to-speech proxy. |
| `POST` | `/transcribe-token` | Short-lived AssemblyAI streaming token. |
| `POST` | `/integrations/statuses` | Which toolkits are connected. |
| `POST` | `/integrations/:toolkit/connect` | Create a Composio connection link. |
| `DELETE` | `/integrations/:toolkit/disconnect` | Remove connected accounts for a toolkit. |

All routes require a Clerk session token.

`GET /models` exists so a client can build a model picker without hardcoding a list. It returns the capability flags Ollama reports, so a UI can, for example, grey out models that can't see images:

```json
{
  "defaultModel": "qwen3-vl:8b",
  "models": [
    {
      "id": "qwen3-vl:8b",
      "name": "qwen3-vl:8b",
      "family": "qwen3vl",
      "parameterSize": "…",
      "quantization": "…",
      "contextLength": 0,
      "sizeBytes": 0,
      "capabilities": { "completion": true, "vision": true, "tools": true, "thinking": true }
    }
  ]
}
```

(`parameterSize`, `quantization`, `contextLength` and `sizeBytes` are whatever your Ollama reports for the models you actually have.)

It returns `503` if Ollama isn't reachable and `502` if Ollama answers with an error. Note it sits behind Clerk like every other route — for an unauthenticated setup-time check, ask Ollama directly: `curl http://localhost:11434/api/tags`.

## App integrations with Composio

The server uses `@composio/core` with the Composio Vercel provider. When a signed-in user asks for something that involves an external app, the server looks up that user's connected accounts and loads the relevant toolkit tools into the `streamText` call. Tools are only loaded when the request actually calls for external-app work.

Composio OAuth returns to the app via:

```txt
glide://composio/callback
```

Allow that redirect URL wherever your Composio setup requires it.

Remember that this path needs a model with `tools` support. With a vision-only model, chat and screen understanding work fine and integrations are simply ignored.

## Deployment

Sunflower is built around a local Ollama, and `localhost` means something different inside a deployed Cloudflare Worker than it does on your Mac. Two options:

**Run the Worker locally (recommended).** `pnpm run dev:server` on the same machine as Ollama. Everything stays on your Mac.

**Deploy the Worker and expose Ollama.** Point `OLLAMA_HOST` at an Ollama instance the Worker can reach over the network — a tunnel, or a machine you control:

```bash
pnpm run deploy:server
cd apps/server
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put GRADIUM_API_KEY
npx wrangler secret put COMPOSIO_API_KEY
```

Set `OLLAMA_HOST` in `wrangler.toml` under `[vars]`. (If you'd rather store it as a secret because the URL is sensitive, you must also **delete** the `OLLAMA_HOST` line from `[vars]` — a plain var with the same name overrides the secret on every deploy.)

If you do this, **put authentication in front of Ollama.** The Ollama API has no auth of its own — anything that can reach it can use your GPU and read your prompts. Never expose port `11434` directly to the internet.

## Scripts

- `pnpm run dev` — start all configured apps
- `pnpm run dev:server` — start the Worker locally
- `pnpm run check-types` — TypeScript checks
- `pnpm run deploy:server` — deploy the Worker

## Troubleshooting

**Answers ignore what's on screen.** The model probably has no `vision` capability — check `ollama show <model>`. If it does, `OLLAMA_NUM_CTX` may be too small for the screenshot.

**Integrations never fire.** The model has no `tools` capability. `ollama show <model>` will tell you.

**First reply is very slow.** Ollama loads the model into memory on first use. The Electron app now preloads it at launch and when you start speaking, shows `waking the model…` while it loads, and waits up to ~3 minutes for a cold first token (45 s once warm). If it still times out — `the model is still loading` — warm it manually with `ollama run <model>` or switch to a smaller vision model such as `minicpm-v`.

**The app connects but answers come back empty.** `/chat` checks Ollama before it starts streaming, so the two most common causes now come back as a normal HTTP error instead of an empty answer: `503` means it can't reach Ollama at all (not running, wrong `OLLAMA_HOST`); `404` means Ollama is up but the requested model has never been pulled (`OLLAMA_MODEL` names a model you don't actually have — Ollama does not pull on demand). Either way the response body is `{ "error": "…" }` with Ollama's own message where there is one (e.g. `model 'qwen3-vl:8b' not found, try pulling it first`).

If Ollama instead fails *after* streaming has already started — it goes away mid-answer, the model gets unloaded concurrently, or you cancel the request — `/chat` has already committed to HTTP 200, so the failure travels inside the stream as an AI SDK `error` chunk (`{ "type": "error", "errorText": "…" }`) instead of a response status. The macOS app now surfaces this instead of leaving you with dead air: `AISDK.swift` recognizes the `error` event type, extracts `errorText`, and throws it up to `CompanionManager`, which shows the message in the companion's response bubble near the cursor and speaks it (a short "sorry, i ran into a problem answering that" if the error text is long, the message itself if it's short). The Electron app doesn't go through this Worker/AI SDK path at all — it talks to Ollama's native `/api/chat` directly — but hits the same class of mid-stream failure and handles it the same way in spirit: it watches for an `error` field in Ollama's own NDJSON stream and, when it finds one, surfaces a red `[!!]` banner in the status island (auto-clearing after a couple of seconds) plus an `[sunflower] error: …` line in the terminal. Either way, check the Worker logs (`pnpm run dev:server` prints the Ollama error, e.g. `model 'qwen3-vl:8b' not found`), confirm Ollama is up (`curl http://localhost:11434/api/tags`), and confirm `OLLAMA_MODEL` names a model you have actually pulled.

**Everything returns 401.** Clerk keys in `.dev.vars` and in the Xcode build settings must come from the same Clerk application.

## License

MIT — see [LICENSE](LICENSE).
