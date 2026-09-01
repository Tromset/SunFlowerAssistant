# The Swift prototype (`apps/macos`)

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [guide: setup](../guide/setup.md), [internals: server](server.md)

Kept for reference; **not what runs**. The Xcode project, scheme and target are
still named `Glide`, and the URL scheme is still `glide://` — renaming is
cosmetic and would risk breaking the Clerk and Composio redirect flows.

Notable files:

| File | Role |
| --- | --- |
| `GlideApp.swift`, `AppBundleConfiguration.swift` | app entry, Info.plist-injected config |
| `GlobalPushToTalkShortcutMonitor.swift` | push-to-talk |
| `CompanionScreenCaptureUtility.swift` | screen capture |
| `AISDK.swift` | Worker `/chat` client, including the in-stream `error` chunk |
| `AssemblyAIStreamingTranscriptionProvider.swift`, `AppleSpeechTranscriptionProvider.swift`, `BuddyTranscriptionProvider.swift` | transcription backends |
| `GradiumTTSClient.swift` | speech |
| `CompanionManager.swift`, `CompanionPanelView.swift`, `CompanionResponseOverlay.swift` | the companion |
| `GlideDynamicIslandManager.swift`, `MenuBarPanelManager.swift` | status surfaces |
| `GlideAuthManager.swift` | Clerk |
| `GlideAnalytics.swift` | **opt-in** PostHog, hard no-op without a key |

Build config comes from a **gitignored** `apps/macos/Config.xcconfig` (copy
`Config.xcconfig.example`): `CLERK_PUBLISHABLE_KEY`, `DEVELOPMENT_TEAM`,
optional `POSTHOG_API_KEY` and `GLIDE_SERVER_BASE_URL`. Without that file the
build fails immediately rather than silently signing with someone else's
credentials.
