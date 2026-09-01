# The orb

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: sunflower-code](sunflower-code.md), [internals: sunflower-work](sunflower-work.md)

A small pixel sunflower docked to the right edge of the screen, visible only
while **Sunflower-Code** or **Sunflower Work** is busy. It is the only sign of
life when neither app has a window open.

The main process translates both runners into one neutral payload
(`shared/orb.ts`) so the renderer never has to know either feature's state
model:

```ts
interface OrbRun {
  id: string;
  source: "code" | "work";
  title: string;   // project folder for Code, task for Work
  state: string;   // already-written text: "turn 3/8 · thinking…", "step 12"
  active: boolean; // the disc is lit
  working: boolean; // a model call or tool is actually in flight
}
```

`refreshOrb()` in `main/index.ts` rebuilds that list from
`codeSession.info()` and the active Work sessions, then pushes it over
`sf:orb:changed` and shows or hides the window. It runs from events the two
runners already emit — the code session's `onEvent` and the work runner's
`onSessionsChanged`/`onFinished` — so **the orb has no timer of its own**.
Token bursts don't repaint anything: the derived payload is compared against
the last one sent and identical states are dropped.

`working` is deliberately narrower than `active`: an approval prompt or a
paused errand leaves the disc lit but stops the ring animation, so movement
always means the machine is doing something rather than waiting on you.

Hovering expands the status pill (the main process widens the window; the pill
lays out to the left). Dragging repositions it, persisted as `orbY`. A plain
click — as opposed to a drag, separated by a 3 px threshold — opens the app the
badge is currently showing.
