# Island renderer

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

The status island under the menu-bar notch; also owns mic capture.

## Files

| File | Purpose |
| --- | --- |
| [`island.html`](island.html) | Markup for the island states and mic UI |
| [`island.ts`](island.ts) | Renders island states and captures 16 kHz mono mic audio |
| [`island.css`](island.css) | Styles for island states, wave, bees |
| [`capture-worklet.ts`](capture-worklet.ts) | AudioWorklet posting mono PCM chunks to the island |

## When to read what

| Question | Read |
| --- | --- |
| How is mic audio captured? | [`capture-worklet.ts`](capture-worklet.ts) |
| How do island states render? | [`island.ts`](island.ts) |
