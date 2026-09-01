# Vendored libraries

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

CommonJS helpers shared by the CLIs (which run without a build) and the app.

## Files

| File | Purpose |
| --- | --- |
| [`ollama-api.cjs`](ollama-api.cjs) | Shared CommonJS Ollama client: tags, pull, reachability |
| [`ollama-api.d.cts`](ollama-api.d.cts) | TypeScript declarations for the shared Ollama client |

## When to read what

| Question | Read |
| --- | --- |
| How do the CLIs talk to Ollama? | [`ollama-api.cjs`](ollama-api.cjs) |
