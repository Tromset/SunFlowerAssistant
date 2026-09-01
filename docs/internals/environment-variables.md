# Environment variables

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: configuration](configuration.md)

| Variable | Scope | Effect |
| --- | --- | --- |
| `OLLAMA_HOST` | Electron, CLIs | overrides `config.ollamaHost` |
| `SUNFLOWER_DEBUG=1` | Electron | full error details, raw unfiltered native logs, pointer diagnostics, watchdog start line |
| `SUNFLOWER_NO_DOUBLE_CHECK=1` | Electron | skip pointing refinement entirely (DOM snap + second vision pass) |
| `SUNFLOWER_FAKE_ANSWER=…` | Electron | replay that text as if streamed — end-to-end parser/guide tests without Ollama (also disables the second vision pass; DOM framing stays active) |
| `NO_COLOR` | Electron TUI | degrade to plain log lines |
| `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, `WISPR_FLOW_API_KEY` | `requirements` | optional entries, never fail the check when unset |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Worker | **required** — every route is authenticated |
| `ASSEMBLYAI_API_KEY`, `GRADIUM_API_KEY`, `COMPOSIO_API_KEY` | Worker | per feature |
| `GRADIUM_TTS_MODEL`, `GRADIUM_TTS_VOICE_ID` | Worker | TTS tuning, defaults in `wrangler.toml` |
| `OLLAMA_MODEL`, `OLLAMA_NUM_CTX` | Worker | see above |
