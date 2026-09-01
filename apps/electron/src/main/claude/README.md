# Claude Code bridge

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Notices finished Claude Code sessions via hooks and a spool folder — read-only, event-driven.

## Files

| File | Purpose |
| --- | --- |
| [`index.ts`](index.ts) | Assembles the watcher API from hooks, spool and store |
| [`hooks.ts`](hooks.ts) | Installs/uninstalls the Sunflower hook block in `~/.claude/settings.json` (byte-for-byte restore) |
| [`spool.ts`](spool.ts) | `fs.watch` on the spool folder, draining hook payload files eventfully |
| [`store.ts`](store.ts) | In-memory session registry emitting finish events (rings + chime) |

## When to read what

| Question | Read |
| --- | --- |
| What exactly is written to Claude's settings? | [`hooks.ts`](hooks.ts) |
| How do hook events reach Sunflower? | [`spool.ts`](spool.ts) |
| How are live sessions tracked? | [`store.ts`](store.ts) |
