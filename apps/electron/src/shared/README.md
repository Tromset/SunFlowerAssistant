# Shared modules

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Pure types and logic shared main ↔ renderer — no electron, no node imports.

## Files

| File | Purpose |
| --- | --- |
| [`state.ts`](state.ts) | App phases, island states, poses, permissions, `PanelData` |
| [`ipc.ts`](ipc.ts) | IPC channel constants (`CH`), payloads and the `SunflowerBridge` interface |
| [`config-schema.ts`](config-schema.ts) | `SunflowerConfig` shape and `DEFAULT_CONFIG` |
| [`code.ts`](code.ts) | Code modes, tools, permission gates, bounds, transcript types |
| [`work.ts`](work.ts) | Work statuses, actions, settings + clamping helpers |
| [`claude.ts`](claude.ts) | Claude Code task states, hook events, payload parsing |
| [`orb.ts`](orb.ts) | What the right-edge badge shows (`OrbRun`/`OrbSource`) |
| [`activity.ts`](activity.ts) | Activity families and frontmost-app/site classification |
| [`effort.ts`](effort.ts) | low/medium/high token and turn budgets for the four surfaces |
| [`diff.ts`](diff.ts) | Bounded line-LCS diff shared by Code and the panel |
| [`sunflower-pixels.ts`](sunflower-pixels.ts) | All pixel art: poses, moods, brackets, menu-bar icon, bee, field |

## When to read what

| Question | Read |
| --- | --- |
| Which IPC channels exist? | [`ipc.ts`](ipc.ts) |
| What is in config.json? | [`config-schema.ts`](config-schema.ts) |
| Which modes/tools/gates does Code define? | [`code.ts`](code.ts) |
| Where is the pixel art? | [`sunflower-pixels.ts`](sunflower-pixels.ts) |
| How are effort budgets defined? | [`effort.ts`](effort.ts) |
