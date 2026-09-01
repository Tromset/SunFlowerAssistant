# Electron app source

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

TypeScript source, one folder per Electron process role.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`main/`](main/README.md) | Main process (Node): wiring, pipelines, windows, harnesses |
| [`preload/`](preload/README.md) | contextBridge exposing the typed `window.sunflower` bridge |
| [`renderer/`](renderer/README.md) | One bundle per window surface (IIFE, browser) |
| [`shared/`](shared/README.md) | Pure types + logic shared main ↔ renderer — no electron, no node |

## When to read what

| Question | Read |
| --- | --- |
| Where is app behaviour implemented? | [`main/README.md`](main/README.md) |
| How do renderers call the main process? | [`preload/index.ts`](preload/index.ts) |
| Where is a window's UI code? | [`renderer/README.md`](renderer/README.md) |
| Where are shared types and pure logic? | [`shared/README.md`](shared/README.md) |
