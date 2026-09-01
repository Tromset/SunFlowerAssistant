# Sunflower

> **Navigation:** root hub · [brain.yaml](brain.yaml) — every folder in this repository has a `README.md` hub and a `brain.yaml` routing card. Start here, follow one hub link, and read only the file you need.

Sunflower is a macOS screen companion that runs on **local models**. It lives in your menu bar, sees your screen, and answers out loud — and the model doing the thinking runs on your own machine through [Ollama](https://ollama.com). No model provider, no per-token bill, no screenshots leaving your Mac.

![Cursor companion with speech bubble](apps/electron/docs/screenshots/companion.png)

All documentation lives in the [docs hub](docs/README.md): a screenshot-driven [user guide](docs/guide/README.md) (install, run, use) and the [technical internals](docs/internals/README.md) (architecture, pipelines, contracts).

## Sections

| Hub | What's inside |
| --- | --- |
| [`docs/`](docs/README.md) | All documentation: user guide + technical internals |
| [`apps/`](apps/README.md) | The three applications: Electron companion, Swift prototype, Cloudflare Worker |
| [`packages/`](packages/README.md) | Shared workspace packages (TypeScript config) |

## Root files

| File | Purpose |
| --- | --- |
| [`TODO.md`](TODO.md) | Running task list for the repo |
| [`LICENSE`](LICENSE) | MIT license |
| [`requirements.txt`](requirements.txt) | Declarative project requirements — checked by `sunflower requirements`, never `pip install`ed |
| [`package.json`](package.json) | Workspace root: `dev`, `check-types`, `dev:server`, `start` scripts and shared dev deps |
| [`pnpm-workspace.yaml`](pnpm-workspace.yaml) | pnpm workspace globs and the dependency catalog |
| [`pnpm-lock.yaml`](pnpm-lock.yaml) | pnpm lockfile (machine-generated — do not edit) |
| [`turbo.json`](turbo.json) | Turborepo task pipeline |
| [`tsconfig.json`](tsconfig.json) | Root TypeScript config |
| [`bts.jsonc`](bts.jsonc) | Better-T-Stack scaffold record (safe to delete, kept for provenance) |
| [`.gitignore`](.gitignore) | Git ignore rules |

## Quick start

- Run the fully local Electron app: [docs/guide/electron-app.md](docs/guide/electron-app.md)
- Set up the Swift app + Worker stack: [docs/guide/setup.md](docs/guide/setup.md)
- Something's broken: [docs/guide/troubleshooting.md](docs/guide/troubleshooting.md)

## License

MIT — see [LICENSE](LICENSE).
