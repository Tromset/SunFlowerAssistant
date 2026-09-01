# Pointing

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: guide-mode](guide-mode.md), [guide: pointing](../guide/pointing.md)

The frame draws **immediately** from the model's own box — pointing never waits
on a round-trip. A **double check** then refines it *in place*, treating the
first marker as a claim to improve rather than a gate.

```mermaid
flowchart TD
    M["[POINT:…] parsed"] --> SHOW["showPoint() — frame drawn NOW<br/>pointerLive = true"]
    SHOW --> V{"resolvePoint available?<br/>(SUNFLOWER_NO_DOUBLE_CHECK=1 disables)"}
    V -- no --> DONE["frame stays as drawn"]
    V -- yes --> DOM{"frontmost app exposes DOM?<br/>Safari / Chromium + 'Allow JavaScript from Apple Events'"}
    DOM -- yes --> SNAP["dom-locator.ts:<br/>osascript JXA injects page JS,<br/>collects visible interactive elements<br/>with exact screen boxes"]
    SNAP --> NEAR["snapToElement():<br/>nearest element within 90 px,<br/>or 300 px if its label appears in the answer"]
    DOM -- no --> CROP["point-verifier.ts:<br/>crop a zoom around the claimed box<br/>(×3, clamped 20–55% of screen)"]
    CROP --> PASS2["second vision pass:<br/>'reply with exactly one marker'<br/>6 s budget, num_predict 60"]
    PASS2 --> MISS{"[MISS] or timeout?"}
    MISS -- yes --> DONE
    MISS -- no --> GATE
    NEAR --> GATE{"still same turn AND<br/>pointerLive still true?"}
    GATE -- no --> DROP["correction dropped —<br/>never resurrect a faded frame"]
    GATE -- yes --> REDRAW["showPoint(corrected)"]
```

**Frame geometry** (`main/windows/pointer.ts`): constant-thickness pixel-art
brackets, 10 px padding (`FRAME_PAD_PX`), clamped between 60×48 px and 70 % of
the screen (`FRAME_MAX_FRAC`), always fully on screen. The window itself is
15 % larger than the frame so the scale-in animation is not clipped.

**Guide steps are different**: their targets are DOM-snapped from a *single*
snapshot **before** the step is drawn — visible-target steps only — so guide
execution stays deterministic with no extra model calls between steps.

Every fallback is silent and non-blocking. `SUNFLOWER_DEBUG=1` logs each
marker's raw text, the detected convention and the final frame rectangle.
