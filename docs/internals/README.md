# Technical internals

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Technical reference for the monorepo — architecture, pipelines, contracts, budgets.

## Files

| File | Purpose |
| --- | --- |
| [`overview.md`](overview.md) | The two implementations, product definition, core feature table, license |
| [`architecture.md`](architecture.md) | Repository map, two implementations of one idea, Electron process topology, the IPC contract |
| [`voice-pipeline.md`](voice-pipeline.md) | Session state machine, screen capture, local Whisper, the Ollama client, answer parsing |
| [`pointing.md`](pointing.md) | Bounding-box markers, coordinate normalisation, DOM-first/vision-second refinement |
| [`guide-mode.md`](guide-mode.md) | Multi-step `[STEP:…]` plans executed deterministically, no model calls between steps |
| [`sunflower-code.md`](sunflower-code.md) | Harness internals: the agentic loop, two tool dialects, compaction, the window |
| [`sunflower-work.md`](sunflower-work.md) | Errand runner internals: context renewal, presence guard, the action grammar |
| [`orb.md`](orb.md) | The right-edge activity badge and its event-driven updates |
| [`claude-bridge.md`](claude-bridge.md) | How Sunflower notices finished Claude Code sessions: hooks, spool, undo guarantees |
| [`moods.md`](moods.md) | Event-driven frontmost-app detection and the accessory props |
| [`surfaces.md`](surfaces.md) | The companion, the menu-bar panel and onboarding windows |
| [`terminal.md`](terminal.md) | Terminal interface internals and the slash-command table |
| [`cli-tools.md`](cli-tools.md) | `sunflower`, `sunflower-code`, `sunflower-models`, `sunflower-requirements`, app packaging |
| [`configuration.md`](configuration.md) | Configuration reference: `config.json` fields, defaults, who writes them |
| [`effort-and-budget.md`](effort-and-budget.md) | Effort budgets across the four surfaces and the always-on recurring-cost budget |
| [`watchdog.md`](watchdog.md) | Per-process CPU/RSS JSONL sampling — and its known blind spot |
| [`security-privacy.md`](security-privacy.md) | What leaves the machine, tool confinement, the shell guard |
| [`server.md`](server.md) | Worker internals: the `/chat` error contract, Ollama tuning, Composio, deployment |
| [`swift-prototype.md`](swift-prototype.md) | The earlier Swift/AppKit implementation, kept for reference |
| [`build-system.md`](build-system.md) | esbuild bundling, static copying, scripts, conventions |
| [`environment-variables.md`](environment-variables.md) | Every environment variable read by the apps and scripts |
| [`file-reference.md`](file-reference.md) | Responsibility tables for the Electron source tree |
| [`troubleshooting.md`](troubleshooting.md) | Symptom-by-symptom diagnosis for the technical reader |

## When to read what

| Question | Read |
| --- | --- |
| How do the pieces fit together (processes, IPC)? | [`architecture.md`](architecture.md) |
| How does voice → screenshot → answer actually flow? | [`voice-pipeline.md`](voice-pipeline.md) |
| How are pointing boxes parsed and verified? | [`pointing.md`](pointing.md) |
| How does the coding harness loop work? | [`sunflower-code.md`](sunflower-code.md) |
| How does the errand runner survive long tasks? | [`sunflower-work.md`](sunflower-work.md) |
| How does the Claude Code bridge work and what does it write? | [`claude-bridge.md`](claude-bridge.md) |
| Why is there no polling anywhere / what is the always-on budget? | [`effort-and-budget.md`](effort-and-budget.md) |
| What data leaves the machine? | [`security-privacy.md`](security-privacy.md) |
| How does the Worker behave (errors, tuning, deploy)? | [`server.md`](server.md) |
| How is the project built? | [`build-system.md`](build-system.md) |
| Which env vars exist? | [`environment-variables.md`](environment-variables.md) |
| Which file owns which responsibility? | [`file-reference.md`](file-reference.md) |
