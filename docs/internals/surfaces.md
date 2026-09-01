# Surfaces and windows

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: voice-pipeline](voice-pipeline.md), [internals: orb](orb.md)

### The companion

Two modes, persisted as `companionMode`:

- **`follow`** — chases the cursor, bubble on the right (or left near the right
  edge, `CH.flip`).
- **`docked`** — a compact ~110×110 badge parked in the bottom-right of the
  work area, with a scaled-down bubble. The tracking loop **stops entirely**.

Toggled by double-clicking the flower, the panel's roam/dock control, or the
tray menu — all three paths go through `setCompanionDocked()` so they stay in
sync. A docked companion re-pins itself on `display-metrics-changed`.

**The tracking loop** is the single most-tuned piece of the app, because it
caused the original "this app is heating up my Mac" report:

| State | Cadence |
| --- | --- |
| cursor moving | `FAST_MS = 33` (~30 fps) |
| cursor still ≥ 3 s | `SLOW_MS = 166` (~6 Hz) |
| docked / hidden / `hold` | **loop stopped** (`setLoop(null)`) |
| target position unchanged | `setBounds` **skipped** (`placed` cache) |

Decorative animations (sway, blinking caret, every mood keyframe) pause after
60 s of *real stillness* — the rule is a **wildcard** over everything the
flower carries, so the next decorative animation is covered without anyone
remembering to add it.

The window is click-through everywhere except the flower itself: `forward:
true` lets the renderer see `mousemove`, and hovering the flower flips
`setIgnoreMouseEvents` just long enough for the double-click to land.

### The menu-bar panel

Four tabs: **home** (permissions, model, voice, moods toggle, roam/dock),
**work ↗**, **code ↗**. The footer's **quit** is a real button:
`shutdownEverything()` cancels the running errand, the
Sunflower-Code session, the voice, the mood watcher and the Work/Code windows
before the app exits.

The panel **sizes its window to its own card**: the renderer measures the
card's natural height and `resizePanel()` follows, clamped to the screen with
room for the shadow; past that clamp the view scrolls *inside* the card, so the
rounded bottom corners are never cut off.

### Onboarding

Three steps on first launch: welcome → permissions → local model. Closing it
without finishing quits the app. `onboardingDone()` sets `onboarded: true`,
shows the main surfaces and kicks off the Whisper download.

**Permissions** (`main/permissions.ts`), all granted to the Electron binary:

| Id | Source of truth |
| --- | --- |
| `microphone` | `systemPreferences.getMediaAccessStatus("microphone")` |
| `accessibility` | `isTrustedAccessibilityClient(false)` — required for the global hotkey and the presence guard |
| `screen` | `getMediaAccessStatus("screen")` |
| `screenContent` | screen granted **and** a capture actually succeeded (`screenCaptureConfirmed`) |

Screen recording has a macOS quirk: its Settings pane only lists an app *after*
it has attempted a capture, and there is no "+" button. So the first "grant"
click **attempts a capture** to register the app and trigger the system prompt;
a second click opens the now-populated pane.
