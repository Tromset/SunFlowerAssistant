# Setup — prerequisites, the Worker, and the Swift app

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: server](../internals/server.md), [internals: environment-variables](../internals/environment-variables.md), [guide: electron-app](electron-app.md)

## Prerequisites

- macOS with Xcode installed
- Node.js and pnpm
- [Ollama](https://ollama.com) running locally
- A Clerk application (required — every API route is authenticated)
- Optional, per feature: AssemblyAI (transcription), Gradium (speech), Composio (app integrations)

## 1. Install Ollama and pull a model

```bash
brew install ollama
ollama serve
```

Or download the app from [ollama.com/download](https://ollama.com/download).

Then pull a model. Sunflower's default is `qwen3-vl:8b`:

```bash
ollama pull qwen3-vl:8b
```

**Pick a model with the right capabilities.** Sunflower sends screenshots, so you want a model with `vision`. If you plan to use the Composio integrations, you also need `tools`:

| Model | Vision | Tools | Notes |
| --- | --- | --- | --- |
| `qwen3-vl:8b` | ✅ | ✅ | Default. Good balance of quality and speed. |
| `qwen3-vl:32b` | ✅ | ✅ | Better answers, needs a lot more RAM. |
| `llama3.2-vision` | ✅ | ❌ | Vision only — no app integrations. |
| `gemma3` | ✅ | ❌ | Vision only — no app integrations. |
| `minicpm-v` | ✅ | ❌ | Small and fast, vision only. |

Check what a model actually supports:

```bash
ollama show qwen3-vl:8b
```

A model without `vision` will not be able to see your screen. A model without `tools` will ignore the connected-app integrations.

## 2. Install dependencies

```bash
pnpm install
```

## 3. Configure the Worker

Create `apps/server/.dev.vars`:

```bash
# Required — every route is behind Clerk
CLERK_SECRET_KEY=...
CLERK_PUBLISHABLE_KEY=...

# Optional, per feature
ASSEMBLYAI_API_KEY=...   # /transcribe-token
GRADIUM_API_KEY=...      # /tts
COMPOSIO_API_KEY=...     # app integrations

# Optional TTS tuning — defaults live in wrangler.toml
GRADIUM_TTS_MODEL=default
GRADIUM_TTS_VOICE_ID=...

# Ollama — defaults also live in wrangler.toml
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3-vl:8b
OLLAMA_NUM_CTX=32768
```

The Ollama settings are plain vars, not secrets, so they are already in `apps/server/wrangler.toml` with the defaults above. Only override them in `.dev.vars` if you want different values locally.

### About `OLLAMA_NUM_CTX`

Ollama defaults to a 4096-token context window. A screenshot plus Sunflower's own instructions blows straight through that, and the result is silent truncation — the model behaves as if it never saw part of your screen. Sunflower therefore always sends an explicit `num_ctx`, defaulting to 32768.

If you have limited RAM, lower it (`16384`). If you send large screenshots or hold long conversations, raise it — but the ceiling is whatever the model itself supports, and a larger window costs memory.

## 4. Run the Worker

```bash
pnpm run dev:server
```

It listens on `http://localhost:8787`.

## 5. Configure and run the macOS app

The app reads these values from Xcode build settings, injected into `apps/macos/Glide/Info.plist`:

```txt
GLIDE_SERVER_BASE_URL   # e.g. http://localhost:8787
CLERK_PUBLISHABLE_KEY   # must match the Clerk app the server uses
CLERK_CALLBACK_SCHEME   # usually glide
CLERK_REDIRECT_URL      # usually glide://callback
```

If `GLIDE_SERVER_BASE_URL` is unset, the app falls back to `http://localhost:8787`.

`CLERK_PUBLISHABLE_KEY` and `DEVELOPMENT_TEAM` (your Apple Developer Team ID, used for code signing) are **not** committed — they live in a gitignored `apps/macos/Config.xcconfig` that the `Glide` target's Debug and Release build configurations load as their base configuration. Without that file the build fails immediately (`Config.xcconfig: No such file or directory`) instead of silently signing with, or authenticating against, someone else's credentials.

Set it up:

```bash
cd apps/macos
cp Config.xcconfig.example Config.xcconfig
```

Then edit `Config.xcconfig` and fill in:

- `CLERK_PUBLISHABLE_KEY` — the publishable key from the same Clerk application as your server's `CLERK_SECRET_KEY`. Using a different Clerk app's key means every server call 401s.
- `DEVELOPMENT_TEAM` — your Apple Developer Team ID (Signing & Capabilities > Team in Xcode, or [developer.apple.com/account](https://developer.apple.com/account) under Membership). A free personal team works for local development.
- `POSTHOG_API_KEY` — optional, and only relevant if you want the opt-in analytics described above to actually go somewhere. Leave it blank to keep analytics a hard no-op regardless of the in-app toggle, or fill in your own PostHog project's key to collect those events yourself.

`Config.xcconfig.example` documents each key, including the optional `GLIDE_SERVER_BASE_URL` override.

Then:

```bash
open apps/macos/Glide.xcodeproj
```

1. Select the `Glide` scheme.
2. Confirm your signing team under Signing & Capabilities matches `DEVELOPMENT_TEAM`.
3. Cmd + R.

Sunflower appears in the menu bar. Sign in, grant the screen-recording and microphone permissions it asks for, and hold your push-to-talk key.
