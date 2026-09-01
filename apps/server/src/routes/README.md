# Routes

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

One module per HTTP route family.

## Files

| File | Purpose |
| --- | --- |
| [`chat.ts`](chat.ts) | `POST /chat` — streams Ollama chat, optional Composio tools, pointing instructions |
| [`models.ts`](models.ts) | `GET /models` — local Ollama models with capabilities |
| [`tts.ts`](tts.ts) | `POST /tts` — Gradium text-to-speech proxy returning WAV |
| [`transcribe.ts`](transcribe.ts) | `POST /transcribe-token` — short-lived AssemblyAI streaming tokens |
| [`integrations.ts`](integrations.ts) | `/integrations/*` — Composio toolkit status, connect, disconnect |

## When to read what

| Question | Read |
| --- | --- |
| How does chat streaming and its error contract work? | [`chat.ts`](chat.ts) |
| How are model capabilities reported? | [`models.ts`](models.ts) |
| How do Composio connections work? | [`integrations.ts`](integrations.ts) |
