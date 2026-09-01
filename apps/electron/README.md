# `sunflower` — the Electron app

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Fully local Electron screen companion: local Whisper + local Ollama, no server, no API keys.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`assets/`](assets/README.md) | Committed binary assets (the Finder icon) |
| [`bin/`](bin/README.md) | CLI entry points: `sunflower`, `sunflower-code`, `sunflower-models`, `sunflower-requirements` |
| [`docs/`](docs/README.md) | Screenshots embedded in the documentation |
| [`lib/`](lib/README.md) | Vendored CommonJS Ollama client shared by the CLIs and the main process |
| [`scripts/`](scripts/README.md) | Build, packaging, icon and always-on-budget scripts |
| [`src/`](src/README.md) | TypeScript source: main, preload, renderer, shared |

## Files

| File | Purpose |
| --- | --- |
| [`package.json`](package.json) | Electron package manifest: bins, scripts and dependencies |
| [`tsconfig.json`](tsconfig.json) | TypeScript config extending the shared base, covering `src/**/*.ts` |

## When to read what

| Question | Read |
| --- | --- |
| How do I launch the app from a terminal? | [`bin/sunflower.js`](bin/sunflower.js) |
| How is the app built and bundled? | [`scripts/build.mjs`](scripts/build.mjs) |
| Where is the app source? | [`src/README.md`](src/README.md) |
| Which bins and dependencies does the package declare? | [`package.json`](package.json) |
