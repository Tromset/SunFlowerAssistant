# Troubleshooting

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [guide: troubleshooting](../guide/troubleshooting.md), [internals: watchdog](watchdog.md)

**Answers ignore what's on screen.** The model probably has no `vision`
capability — check `ollama show <model>`. If it does, the context may be too
small for the screenshot.

**Integrations never fire.** The model has no `tools` capability (Worker path
only).

**First reply is very slow.** Ollama loads the model on first use. Sunflower
preloads it at launch and when you start speaking, shows `waking the model…`,
and waits up to ~3 minutes for a cold first token (45 s once warm). If it still
times out, warm it manually with `ollama run <model>` or switch to a smaller
vision model such as `minicpm-v`.

**Empty answers / mid-stream failures.** The Electron app watches for an
`error` field in Ollama's NDJSON stream and surfaces a red `[!!]` banner on the
island plus an `[sunflower] error: …` terminal line. The Worker path uses the
two-shape error contract described above. Either way: confirm Ollama is up
(`curl http://localhost:11434/api/tags`) and that the model is actually pulled
— Ollama does not pull on demand.

**Screen recording won't stick.** Its Settings pane only lists an app after a
capture attempt, and there is no "+" button. Click "grant" once (Sunflower
attempts a capture so macOS registers it), then again to open the populated
pane. In dev the entry is named **Electron**. When macOS offers to "Quit &
Reopen", choose **Later** and rerun `npm start` yourself — the auto-relaunch
starts a bare Electron without Sunflower's app path. The grant survives.

**Push-to-talk does nothing.** Accessibility is not granted. `hotkey.ts` retries
with backoff (3 s, doubling to 60 s) and arms the moment you grant it — no
restart needed.

**Sunflower Work refuses to start.** It is macOS-only, opt-in
(`sunflowerWorkEnabled`), and requires the Accessibility grant for the presence
guard. It also refuses when the screenshot cannot be matched to the current
display (multi-monitor).

**The build fails on a loop budget error.** You added a recurring cost. Either
replace it with an event source (see the table above), or declare it in
`apps/electron/scripts/loop-budget.json` — and if it is on by default and
probes the environment, raise the ceiling in the same commit.

**Everything returns 401** (Worker path). The Clerk keys in `.dev.vars` and in
the Xcode build settings must come from the same Clerk application.
