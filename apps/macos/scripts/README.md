# macOS release scripts

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Automation for shipping a new version of the macOS app.

## Files

| File | Purpose |
| --- | --- |
| [`release.sh`](release.sh) | Build → sign → DMG → notarize → Sparkle appcast → GitHub Release pipeline |
| [`release-process.md`](release-process.md) | How to cut a release with `release.sh`, one-time prerequisites included |

## When to read what

| Question | Read |
| --- | --- |
| How do I ship a new version of the macOS app? | [`release-process.md`](release-process.md) |
| What exactly does the release pipeline run? | [`release.sh`](release.sh) |
