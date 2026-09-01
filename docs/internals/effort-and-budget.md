# Effort and the always-on budget

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: watchdog](watchdog.md), [internals: build-system](build-system.md)

## Effort — one set of budgets for four surfaces

`shared/effort.ts` holds `EFFORT_BUDGETS`: for each preset (`low` / `medium` /
`high`) and each surface (`companion`, `code`, `work`), a
`num_predict`, a `num_ctx`, a turn ceiling and a first-token wait.

Before it existed, those numbers were module constants in four separate files
(`main/ollama.ts`, `code/session.ts`, `work/runner.ts`), so
answering "why did it stop so early?" meant opening all four. **`medium`
reproduces the historical values exactly** — changing preset is a deliberate
act, doing nothing changes nothing.

Two things deliberately do **not** move between presets: the companion's and
Work's context window (both are single-turn — a wider `num_ctx` would cost RAM
and load time for nothing), and the first-token waits, which measure how long a
machine takes to load a model rather than any budget.

Because the turn ceiling is now variable, it travels in
`CodeSessionInfo.maxTurns` instead of an exported constant: the app's gauge
reads the ceiling actually in force, so its denominator can't lie the moment
someone types `/effort high`.

`effortDeadlineMin` is separate — a wall-clock cap per task. It arms **one**
timer for the request in flight, cleared in the `finally`, so nothing survives
the turn and nothing needs declaring in the loop budget.

---

## The always-on budget

> The flower sits on someone's desktop all day. **Anything that runs while the
> user is doing nothing is a bug until it is declared.**

This is the single most-repeated defect in this repository. Four separate
features shipped the same idea — "poll the environment continuously so the
flower can react" — and each produced a report that the app was heating up the
machine:

| Commit | What shipped | How it was fixed |
| --- | --- | --- |
| `7380968` | cursor-follow loop at 62.5 Hz, unconditional `setBounds` | throttled to 30/6 Hz by `9e2f5b3` |
| `33bad63` | guide proximity poll at 20 Hz | kept, but bounded to an active guide |
| `9e2f5b3` | Work clicker spawning `osascript` | fenced behind an opt-in that is off by default |
| `8288bd0` | mood probe: `osascript -l JavaScript` **every 4 s**, on by default | replaced by an event source |

Every one of those fixes was a local throttle explained in a comment, inside a
file the next feature never opened. **A comment does not read itself; a build
that breaks does.** So the rule now lives in `CLAUDE.md` and is enforced by
`apps/electron/scripts/check-loops.mjs`, which runs on **every build** — this
repo has no CI, and the build is the only gate that always runs.

### Look for an event source first

| Need | Use |
| --- | --- |
| the frontmost app changed | `systemPreferences.subscribeWorkspaceNotification` (`main/activity.ts`) |
| the user came back / is active | `presence.onRealInput`, `presence.idleMs` |
| a global click | `hotkey.onGlobalMouseDown` |
| a surface appeared or vanished | `BrowserWindow` `show` / `hide` events |
| sleep, wake, lock | `powerMonitor` |

### The check

```bash
node apps/electron/scripts/check-loops.mjs          # fails the build
node apps/electron/scripts/check-loops.mjs --list   # the live table
```

It parses `src/{main,renderer,shared,preload}/**/*.ts` with the TypeScript AST
and looks for three shapes:

1. `setInterval`,
2. a self-rescheduling `setTimeout` chain,
3. a child-process spawn — but **only** functions actually imported from
   `node:child_process`, otherwise every `/re/.exec(str)` would look like a
   spawn.

Call graphs are followed up to `MAX_DEPTH = 3` within a file, and each site is
anchored by its enclosing function/const name so it survives being moved.

Every site must appear in `scripts/loop-budget.json` with its cadence,
`defaultOn`, `probesEnvironment`, what stops it, and why it exists. Two
ceilings do the real work:

```json
{ "maxDefaultOnRecurring": 2, "maxDefaultOnProbes": 1 }
```

**Only one recurring cost that is on by default may probe the environment** —
currently spent on the cursor-follow loop. Adding a second means raising a
ceiling in the same commit, which is a diff a reviewer cannot miss.

### Declared costs today

| Site | Kind | Cadence | On by default | Probes | Stopped by |
| --- | --- | --- | --- | --- | --- |
| `windows/companion.ts` · `setLoop` | interval | 33 ms → 166 ms | ✅ | ✅ | docked, hidden or `hold` |
| `watchdog.ts` · `createWatchdog` | interval | 5 s | ✅ | ❌ | `dispose()` on `before-quit`, timer `unref()`ed |
| `activity.ts` · `osascriptProbe` | subprocess | event-driven | ✅ | ✅ | no timer at all — one shot per unseen app, URL re-read ≤ 1 / 10 s on real input |
| `dom-locator.ts` · `readFrontmostDom` | subprocess | per marker | ✅ | ✅ | `SUNFLOWER_NO_DOUBLE_CHECK=1` |
| `index.ts` · `ensureStatusLoop` | interval | 3 s | ❌ | ✅ | first tick where neither panel nor onboarding is visible |
| `tui.ts` · `startSpinner` | interval | 120 ms | ❌ | ❌ | end of each phase |
| `guide-runner.ts` · `enterStep` | interval / timer | 50 ms / 6 s | ❌ | ✅ / ❌ | guide end, `GUIDE_IDLE_MS` |
| `hotkey.ts` · `scheduleRetry` | timer | 3 s ×2 → 60 s | ❌ | ✅ | the moment uiohook starts |
| `state-machine.ts` · `hotkeyUp` | timer | 10 s | ❌ | ❌ | `clearTimers()` on every transition |
| `work/runner.ts` · `finish` | timer | 0 | ❌ | ❌ | empty queue; Work is opt-in |
| `work/clicker.ts` · `runOsa` | subprocess | per gesture | ❌ | ❌ | opt-in + 20 s real idle |
| `code/tools.ts` · `run` | subprocess | per call | ❌ | ❌ | shell-guard + permission level |

The check is a **heuristic, not a sound analysis**: rescheduling through an
event handler, a promise chain, or a helper in another module gets past it. It
catches the shape that has shipped four times. Passing it is a floor — the
question to ask is still *"what does this cost when nobody is touching the
machine?"*
