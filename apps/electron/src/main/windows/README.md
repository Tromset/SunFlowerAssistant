# Window modules

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

One module per window surface, plus the shared transparent-overlay factory.

## Files

| File | Purpose |
| --- | --- |
| [`common.ts`](common.ts) | Shared preload paths and the transparent overlay window factory |
| [`island.ts`](island.ts) | Status island under the notch + idle visibility |
| [`companion.ts`](companion.ts) | Cursor-following sunflower overlay: fly/hold/dock modes, adaptive tracking loop |
| [`pointer.ts`](pointer.ts) | On-screen pointing bracket overlay sized to the target |
| [`panel.ts`](panel.ts) | Menu-bar panel window, sized to its own card |
| [`onboarding.ts`](onboarding.ts) | First-run onboarding window |
| [`orb.ts`](orb.ts) | Right-edge orb showing active Code/Work runs, draggable |
| [`code.ts`](code.ts) | Persistent hide-on-close Sunflower-Code app window |
| [`work.ts`](work.ts) | Persistent hide-on-close Sunflower Work app window |

## When to read what

| Question | Read |
| --- | --- |
| How does the companion follow the cursor (and dock)? | [`companion.ts`](companion.ts) |
| How is the pointing frame drawn? | [`pointer.ts`](pointer.ts) |
| Why does the panel never cut off? | [`panel.ts`](panel.ts) |
| How are overlay windows configured? | [`common.ts`](common.ts) |
