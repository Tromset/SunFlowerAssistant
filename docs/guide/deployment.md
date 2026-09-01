# Deployment

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: server](../internals/server.md), [internals: build-system](../internals/build-system.md)

Sunflower is built around a local Ollama, and `localhost` means something different inside a deployed Cloudflare Worker than it does on your Mac. Two options:

**Run the Worker locally (recommended).** `pnpm run dev:server` on the same machine as Ollama. Everything stays on your Mac.

**Deploy the Worker and expose Ollama.** Point `OLLAMA_HOST` at an Ollama instance the Worker can reach over the network — a tunnel, or a machine you control:

```bash
pnpm run deploy:server
cd apps/server
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put GRADIUM_API_KEY
npx wrangler secret put COMPOSIO_API_KEY
```

Set `OLLAMA_HOST` in `wrangler.toml` under `[vars]`. (If you'd rather store it as a secret because the URL is sensitive, you must also **delete** the `OLLAMA_HOST` line from `[vars]` — a plain var with the same name overrides the secret on every deploy.)

If you do this, **put authentication in front of Ollama.** The Ollama API has no auth of its own — anything that can reach it can use your GPU and read your prompts. Never expose port `11434` directly to the internet.

## Scripts

- `pnpm run dev` — start all configured apps
- `pnpm run dev:server` — start the Worker locally
- `pnpm run check-types` — TypeScript checks
- `pnpm run deploy:server` — deploy the Worker
