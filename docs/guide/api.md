# API

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: server](../internals/server.md), [guide: setup](setup.md)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/chat` | Streaming chat. Accepts an optional `model` to override `OLLAMA_MODEL` for that request. |
| `GET` | `/models` | Models pulled locally, with capabilities and the configured default. |
| `POST` | `/tts` | Gradium text-to-speech proxy. |
| `POST` | `/transcribe-token` | Short-lived AssemblyAI streaming token. |
| `POST` | `/integrations/statuses` | Which toolkits are connected. |
| `POST` | `/integrations/:toolkit/connect` | Create a Composio connection link. |
| `DELETE` | `/integrations/:toolkit/disconnect` | Remove connected accounts for a toolkit. |

All routes require a Clerk session token.

`GET /models` exists so a client can build a model picker without hardcoding a list. It returns the capability flags Ollama reports, so a UI can, for example, grey out models that can't see images:

```json
{
  "defaultModel": "qwen3-vl:8b",
  "models": [
    {
      "id": "qwen3-vl:8b",
      "name": "qwen3-vl:8b",
      "family": "qwen3vl",
      "parameterSize": "…",
      "quantization": "…",
      "contextLength": 0,
      "sizeBytes": 0,
      "capabilities": { "completion": true, "vision": true, "tools": true, "thinking": true }
    }
  ]
}
```

(`parameterSize`, `quantization`, `contextLength` and `sizeBytes` are whatever your Ollama reports for the models you actually have.)

It returns `503` if Ollama isn't reachable and `502` if Ollama answers with an error. Note it sits behind Clerk like every other route — for an unauthenticated setup-time check, ask Ollama directly: `curl http://localhost:11434/api/tags`.

## App integrations with Composio

The server uses `@composio/core` with the Composio Vercel provider. When a signed-in user asks for something that involves an external app, the server looks up that user's connected accounts and loads the relevant toolkit tools into the `streamText` call. Tools are only loaded when the request actually calls for external-app work.

Composio OAuth returns to the app via:

```txt
glide://composio/callback
```

Allow that redirect URL wherever your Composio setup requires it.

Remember that this path needs a model with `tools` support. With a vision-only model, chat and screen understanding work fine and integrations are simply ignored.
