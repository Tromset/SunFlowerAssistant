# Diagnostics: the watchdog

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: effort-and-budget](effort-and-budget.md), [internals: troubleshooting](troubleshooting.md)

`main/watchdog.ts` samples `app.getAppMetrics()` every 5 seconds and appends a
JSON line to `~/Library/Application Support/sunflower/watchdog/watchdog-YYYY-MM-DD.jsonl`.

- One file per day, pruned automatically to ~5 days and ~5 MB total.
- Sustained CPU ≥ 300 % (roughly three full cores) for ≥ 30 s also logs a
  `warn` line naming every running process and the open `BrowserWindow` count —
  so a "heating up my Mac" report comes with an actual trail.
- It never throws, never blocks on disk I/O (buffered async `appendFile`), and
  never keeps the process alive at quit (`unref()` + explicit `dispose()`).

**Its known blind spot, worth stating because it cost a release:** a
"300 % for 30 seconds" threshold sees a runaway model, but not a steady drip of
short-lived child processes. The mood poll forked an `osascript` every 4 seconds
for days without tripping a single `warn`. That gap is exactly what the static
budget check covers: **the watchdog reports what is already burning, the check
refuses to let it be written.**
