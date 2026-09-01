# `server` — the Cloudflare Worker

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Hono API on a Cloudflare Worker — backend for the Swift app only; every route behind Clerk.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`src/`](src/README.md) | Worker source: app wiring, routes, services, middleware, utils |

## Files

| File | Purpose |
| --- | --- |
| [`package.json`](package.json) | Worker package: scripts and Hono/AI SDK dependencies |
| [`tsconfig.json`](tsconfig.json) | Server TypeScript config with Workers types |
| [`wrangler.toml`](wrangler.toml) | Wrangler config: entry, nodejs_compat, Ollama/TTS defaults under `[vars]` |

## When to read what

| Question | Read |
| --- | --- |
| How is the Worker configured and deployed? | [`wrangler.toml`](wrangler.toml) |
| Where are the routes implemented? | [`src/routes/README.md`](src/routes/README.md) |
