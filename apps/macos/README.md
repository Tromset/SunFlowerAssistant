# `Glide` — the Swift prototype

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Earlier Swift/AppKit menu-bar implementation, kept for reference; talks to the Worker.

## Subfolders

| Hub | What's inside |
| --- | --- |
| [`Glide/`](Glide/README.md) | The app target: Swift sources, plist, entitlements, sounds, asset catalog |
| [`GlideTests/`](GlideTests/README.md) | Unit tests |
| [`GlideUITests/`](GlideUITests/README.md) | UI launch tests |
| [`scripts/`](scripts/README.md) | Release automation |

## Files

| File | Purpose |
| --- | --- |
| [`appcast.xml`](appcast.xml) | Sparkle RSS feed listing signed DMG auto-update releases |
| [`Config.xcconfig.example`](Config.xcconfig.example) | Example local build settings: Clerk key, team ID, PostHog key, server URL |
| [`dmg-background.png`](dmg-background.png) | Drag-to-Applications background for release DMGs |
| [`.gitignore`](.gitignore) | Ignores the local `Config.xcconfig`, builds, releases, Xcode user state |

## Machine-managed artifacts

Not part of the brAIn navigation (rule 5) — linked here so nothing is orphaned.

| Artifact | Purpose |
| --- | --- |
| [`Glide.xcodeproj/project.pbxproj`](Glide.xcodeproj/project.pbxproj) | Xcode project definition |
| [`Glide.xcodeproj/project.xcworkspace/contents.xcworkspacedata`](Glide.xcodeproj/project.xcworkspace/contents.xcworkspacedata) | Xcode workspace pointer |
| [`Glide.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`](Glide.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved) | Pinned SwiftPM dependencies (Sparkle, Clerk, PostHog…) |

## When to read what

| Question | Read |
| --- | --- |
| How do I build and run the Swift app? | [`../../docs/guide/setup.md`](../../docs/guide/setup.md) |
| How do I configure signing and keys? | [`Config.xcconfig.example`](Config.xcconfig.example) |
| Where is the app code? | [`Glide/README.md`](Glide/README.md) |
| How is a release shipped? | [`scripts/README.md`](scripts/README.md) |
