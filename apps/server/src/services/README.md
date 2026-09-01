# Services

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Clients for the external systems the Worker fronts.

## Files

| File | Purpose |
| --- | --- |
| [`ollama.ts`](ollama.ts) | Ollama host/model helpers, preflight reachability and pull checks |
| [`composio.ts`](composio.ts) | Composio client creation and per-user toolkit tool loading |

## When to read what

| Question | Read |
| --- | --- |
| How is Ollama reached and validated? | [`ollama.ts`](ollama.ts) |
| How are per-user tools loaded? | [`composio.ts`](composio.ts) |
