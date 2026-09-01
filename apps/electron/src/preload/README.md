# Preload

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

The contextBridge layer exposing the typed IPC bridge to renderers.

## Files

| File | Purpose |
| --- | --- |
| [`index.ts`](index.ts) | Exposes `window.sunflower` (SunflowerBridge) over contextBridge |

## When to read what

| Question | Read |
| --- | --- |
| What can renderers call? | [`index.ts`](index.ts) |
