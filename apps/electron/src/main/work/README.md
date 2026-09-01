# Sunflower Work

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

The errand runner: vision loop, synthetic gestures, presence-guarded pauses.

## Files

| File | Purpose |
| --- | --- |
| [`runner.ts`](runner.ts) | The capture → vision → gesture loop, with pauses, budgets and context renewal |
| [`actions.ts`](actions.ts) | Catalog of gestures: schemas, needs, help lines |
| [`clicker.ts`](clicker.ts) | Synthesizes macOS mouse/keyboard via osascript CGEvents, tagged as synthetic |
| [`open-guard.ts`](open-guard.ts) | Allows only safe http(s) URLs / non-dangerous app opens |
| [`store.ts`](store.ts) | In-memory run store broadcasting UI events |

## When to read what

| Question | Read |
| --- | --- |
| How does a run decide and act? | [`runner.ts`](runner.ts) |
| Which gestures exist? | [`actions.ts`](actions.ts) |
| How are clicks and keys synthesized? | [`clicker.ts`](clicker.ts) |
| Why was an open refused? | [`open-guard.ts`](open-guard.ts) |
