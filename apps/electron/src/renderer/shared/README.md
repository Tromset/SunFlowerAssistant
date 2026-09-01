# Shared renderer assets

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Base CSS, design tokens, fonts and the browser dev stub shared by all renderers.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`fonts/`](fonts/README.md) | Newsreader woff2 files |
| [`tokens/`](tokens/README.md) | Design-token CSS variables |

## Files

| File | Purpose |
| --- | --- |
| [`base.css`](base.css) | Shared reset, `[hidden]` fix and keyframe animations |
| [`dev-stub.ts`](dev-stub.ts) | Browser stub for `window.sunflower` in design mode |

## When to read what

| Question | Read |
| --- | --- |
| Where are the design tokens? | [`tokens/README.md`](tokens/README.md) |
| How do renderers run outside Electron? | [`dev-stub.ts`](dev-stub.ts) |
