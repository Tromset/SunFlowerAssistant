# Overview

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: overview](../internals/overview.md), [internals: architecture](../internals/architecture.md)

Sunflower is a macOS screen companion that runs on **local models**. It lives in your menu bar, sees your screen, and answers out loud — and the model doing the thinking runs on your own machine through [Ollama](https://ollama.com). No model provider, no per-token bill, no screenshots leaving your Mac.

Sunflower started as a fork of [Glide](https://github.com/shujanshaikh/glide), which itself started as a clone of [Clicky](https://github.com/farzaa/clicky) by [Farza](https://x.com/FarzaTV). This version replaces the hosted-model backend with local inference.

## What it does

You hold a push-to-talk key and talk. Sunflower captures your screen, sends the image plus your transcript to a local vision model, streams the answer back, speaks it out loud, and can point at things on screen with an on-screen cursor. If you connect external apps through Composio, it can also take action in them.

The backend is a small Hono API running on a Cloudflare Worker. It handles:

- authenticated chat streaming against a **local Ollama** instance (native `/api/chat`)
- listing the models you have pulled locally, with their capabilities
- AssemblyAI realtime transcription token generation
- Gradium text-to-speech proxying
- Composio-powered integrations for connected apps (Notion, Google Docs, Gmail, Slack, GitHub, …)
- Clerk authentication for the macOS app and the server routes

### What runs locally, and what doesn't

Only the **language model** is local. Transcription (AssemblyAI), speech (Gradium), auth (Clerk) and app integrations (Composio) are still hosted services, and each is optional in the sense that the feature it powers simply won't work without its key.

> **Telemetry is opt-in and off by default:** the macOS app inherited the upstream project's PostHog analytics, but it's now gated behind an explicit "Share usage data, including message content" toggle (Home tab of the menu-bar panel), backed by the `analyticsOptIn` UserDefaults key. Until you turn it on, `apps/macos/Glide/GlideAnalytics.swift` never initialises PostHog and never sends an event — every capture call site re-checks the flag, not just setup. When enabled, it shares: app-opened/onboarding/permission-granted milestones, push-to-talk start/stop, your transcribed message and the AI's full response text (each with a character count), which on-screen element got pointed at, and response/TTS error messages — attributed to PostHog's auto-generated anonymous distinct ID, never to your identity. The onboarding flow's old behavior of POSTing the email you enter to the upstream author's personal third-party form endpoint, and of calling PostHog's `identify()` with that raw email, have both been removed entirely — sending PII was never something the opt-in should have gated in the first place, so it's just gone. The PostHog project API key itself is no longer hardcoded: it lives in a gitignored `apps/macos/Config.xcconfig` (see "5. Configure and run the macOS app" below), and if you leave it blank, analytics is a hard no-op — PostHog is never initialised, opt-in toggle or not.

## Architecture

```txt
apps/
  electron/ Electron screen companion "sunflower" — fully local (Whisper + Ollama)
  macos/    Native Swift/AppKit menu bar app
  server/   Hono Cloudflare Worker API
packages/
  config/   Shared TypeScript config
```

The app owns the macOS experience: menu bar UI, push-to-talk, screen capture, voice playback, cursor pointing, auth callbacks. The Worker owns authenticated API access, model streaming, transcription tokens, TTS proxying, and tool integrations.

The app never picks a model — it sends messages and the server decides which Ollama model to use. That keeps model configuration in one place (`OLLAMA_MODEL`) and means you can change models without rebuilding the app.

> **Note on naming:** the Xcode project, scheme and target are still named `Glide`, and the app's URL scheme is still `glide://`. Renaming them is cosmetic and risks breaking the Clerk and Composio redirect flows, so it hasn't been done. Wherever this README says `Glide`, it means the Xcode target.

## License

MIT — see [LICENSE](../../LICENSE).
