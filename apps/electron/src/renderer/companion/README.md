# Companion renderer

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

The cursor-following sunflower and its speech bubble.

## Files

| File | Purpose |
| --- | --- |
| [`companion.html`](companion.html) | Markup for the flower and bubble |
| [`companion.ts`](companion.ts) | Pose, bubble streaming, moods, bees, TTS and chime wiring |
| [`companion.css`](companion.css) | Flower, bubble and mood-prop animations |
| [`tts.ts`](tts.ts) | Speaks answers via macOS speechSynthesis |
| [`chime.ts`](chime.ts) | Synthesizes the short completion chime with Web Audio |

## When to read what

| Question | Read |
| --- | --- |
| How does the bubble stream text? | [`companion.ts`](companion.ts) |
| How are answers spoken? | [`tts.ts`](tts.ts) |
| Where do mood animations live? | [`companion.css`](companion.css) |
