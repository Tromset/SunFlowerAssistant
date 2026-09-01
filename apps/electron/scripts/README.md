# Build and tooling scripts

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

esbuild bundling, app packaging, icon generation, and the always-on budget check.

## Files

| File | Purpose |
| --- | --- |
| [`build.mjs`](build.mjs) | esbuild bundler for main, preload and renderers; copies static assets; runs the budget check |
| [`check-loops.mjs`](check-loops.mjs) | Fails the build on undeclared recurring costs (timers, self-rescheduling, spawns) |
| [`loop-budget.json`](loop-budget.json) | The declared budget of permitted recurring timers and probes |
| [`make-app.mjs`](make-app.mjs) | Builds the Finder `SunFlower.app` terminal-launcher shortcut bundle |
| [`make-icon.mjs`](make-icon.mjs) | Generates `SunFlower.icns` from the pixel-art icon source |
| [`native-log-filter.cjs`](native-log-filter.cjs) | Spawns Electron while filtering whisper.cpp/ggml stderr noise into a log file |

## When to read what

| Question | Read |
| --- | --- |
| How does the build work? | [`build.mjs`](build.mjs) |
| Why did the build fail on a loop budget error? | [`check-loops.mjs`](check-loops.mjs) |
| Which recurring costs are declared? | [`loop-budget.json`](loop-budget.json) |
| How is the Finder app bundle made? | [`make-app.mjs`](make-app.mjs) |
