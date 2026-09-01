# Companion features

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: moods](../internals/moods.md), [internals: orb](../internals/orb.md), [internals: claude-bridge](../internals/claude-bridge.md), [internals: surfaces](../internals/surfaces.md)

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

### Telling you when Claude Code is done

You start a long task in Claude Code, switch to something else, and then keep
going back to the terminal to check. The flower is already on your desktop, so
it can just tell you: **when a Claude Code session finishes, three orange rings
spread out from the sunflower and a short two-note chime plays.** That's the
whole notification — no speech, no Notification Center, no badge to dismiss.
The panel's *claude code* section shows which sessions are live meanwhile, and
`/claude` prints the same thing in the terminal.

It's off by default, because switching it on edits a file that belongs to you.
Tick **Notify me when Claude finishes** in the tray menu (or run `/claude on`)
and sunflower adds a small hook block to `~/.claude/settings.json`, pointing at
a fifteen-line shell script in its own data directory. Claude runs that script
when a turn ends; the script drops the event in a spool folder; sunflower
notices and ripples. Untick it and the block is removed — the file comes back
byte-for-byte identical, and there's a copy of the original in
`~/Library/Application Support/sunflower/claude/` either way. Sunflower never
sends anything *to* Claude: the bridge only reads.

Nothing polls. When Claude isn't running, this feature doesn't execute a single
line — no timer, no watcher spinning, nothing added to the always-on budget.
One caveat worth knowing: Claude reads its hooks when a session starts, so a
terminal you already had open won't ripple until you start a new session.
