# Worker source

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Hono app wiring and its route/service/middleware modules.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`chat/`](chat/README.md) | Message conversion and system-prompt builders |
| [`middleware/`](middleware/README.md) | Clerk auth middleware |
| [`routes/`](routes/README.md) | HTTP route handlers |
| [`services/`](services/README.md) | Ollama and Composio clients |
| [`utils/`](utils/README.md) | Audio and logging helpers |

## Files

| File | Purpose |
| --- | --- |
| [`index.ts`](index.ts) | Hono app: CORS, Clerk auth, route mounting |
| [`types.ts`](types.ts) | Env bindings, chat/model request and capability types |

## When to read what

| Question | Read |
| --- | --- |
| How are requests authenticated and routed? | [`index.ts`](index.ts) |
| Which env bindings exist? | [`types.ts`](types.ts) |
