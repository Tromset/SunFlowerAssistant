# sunflower — working notes

A macOS-only Electron app: a pixel sunflower that follows your cursor, looks at
your screen on ⌃⌥, and answers out loud — 100 % locally, through Ollama. The
same binary also opens a terminal UI (`sunflower`), a coding harness
(Sunflower-Code) and an errand runner (Sunflower Work).

- `apps/electron` is the app. `apps/macos` is an earlier Swift prototype, kept
  for reference — it is not what runs.
- `pnpm start` = `node scripts/build.mjs && node bin/sunflower.js`. esbuild
  bundles `src/main` → `dist/main/index.cjs` (CJS), `src/renderer/*` → IIFE.
- `pnpm check-types` = `tsc --noEmit` + the always-on check below. There is no
  test runner and no CI: the build is the only gate that always runs.
- Comments in `src/` are in French; anything the user reads is in English.
- Nothing leaves the machine. No telemetry, no network except the local Ollama
  host. Decorative code never throws and never prints to the terminal.

## The always-on budget

The flower sits on someone's desktop all day. **Anything that runs while the
user is doing nothing is a bug until it is declared.**

This is not a style preference — it is the single most-repeated defect in this
repository. Four separate features have shipped the same idea, "poll the
environment continuously so the flower can react", and each one produced a
report that the app was heating up or killing the machine:

| Commit | What shipped | How it was fixed |
|---|---|---|
| `7380968` | cursor-follow loop at 62.5 Hz, unconditional `setBounds` | throttled to 30/6 Hz by `9e2f5b3` |
| `33bad63` | guide proximity poll at 20 Hz | left as is, but bounded to an active guide |
| `9e2f5b3` | Work clicker spawning `osascript` | fenced behind an opt-in that is off by default |
| `8288bd0` | mood probe: `osascript -l JavaScript` **every 4 s**, on by default | replaced by an event source |

Every one of those fixes was a local throttle explained in a comment, inside a
file the next feature never opened. That is why the rule now lives here and is
enforced by a script instead.

**Before writing a `setInterval`, a self-rescheduling `setTimeout`, an
`osascript` spawn or a `requestAnimationFrame` in `src/main` or
`src/renderer`, look for an event source.** The ones already wired up:

| Need | Use |
|---|---|
| the frontmost app changed | `systemPreferences.subscribeWorkspaceNotification` — see `main/activity.ts` |
| the user came back / is active | `presence.onRealInput`, `presence.idleMs` |
| a global click | `hotkey.onGlobalMouseDown` |
| a surface appeared or vanished | `BrowserWindow` `show` / `hide` events |
| sleep, wake, lock | `powerMonitor` |

If there genuinely is no event, declare the cost in
`apps/electron/scripts/loop-budget.json` — cadence, on-by-default or not,
whether it probes the environment, and what stops it. `scripts/check-loops.mjs`
runs on every build and fails when a site is undeclared, when a declaration is
stale, or when the totals go over budget.

    node apps/electron/scripts/check-loops.mjs --list    # the live table

The budget file is the single source of truth — don't copy the table here, it
will drift. Two ceilings do the actual work: how many recurring costs may be on
by default, and **how many of those may probe the environment** (currently one,
spent on the cursor-follow loop). Adding a second one means raising a ceiling
in the same commit, which is a diff a reviewer cannot miss.

The check is a heuristic, not a sound analysis: rescheduling through an event
handler, a promise chain, or a helper in another module gets past it. It
catches the shape that has shipped four times. Passing it is a floor, not a
guarantee — the question to ask is still "what does this cost when nobody is
touching the machine?"
