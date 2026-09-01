# Glide app target

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Swift sources of the prototype: companion orchestration, auth, transcription, TTS, overlays.

## Files

| File | Purpose |
| --- | --- |
| [`GlideApp.swift`](GlideApp.swift) | App entry: delegate, onboarding gate, menu bar, login item |
| [`CompanionManager.swift`](CompanionManager.swift) | Core orchestration: voice, screen, AI, TTS, overlays |
| [`AISDK.swift`](AISDK.swift) | Authenticated client streaming chat/vision requests to the Worker `/chat` |
| [`GlideAuthManager.swift`](GlideAuthManager.swift) | Clerk Google OAuth sign-in, session tokens, auth events |
| [`BuddyDictationManager.swift`](BuddyDictationManager.swift) | Push-to-talk dictation state, mic capture, transcript pipeline |
| [`BuddyTranscriptionProvider.swift`](BuddyTranscriptionProvider.swift) | Transcription provider protocol + AssemblyAI/Apple factory |
| [`AssemblyAIStreamingTranscriptionProvider.swift`](AssemblyAIStreamingTranscriptionProvider.swift) | WebSocket AssemblyAI streaming via server-issued token |
| [`AppleSpeechTranscriptionProvider.swift`](AppleSpeechTranscriptionProvider.swift) | On-device SFSpeech streaming transcription |
| [`BuddyAudioConversionSupport.swift`](BuddyAudioConversionSupport.swift) | Converts capture buffers to mono PCM16 |
| [`CompanionScreenCaptureUtility.swift`](CompanionScreenCaptureUtility.swift) | Captures displays as JPEG via ScreenCaptureKit |
| [`GradiumTTSClient.swift`](GradiumTTSClient.swift) | Calls the Worker `/tts` and plays the WAV reply |
| [`CompanionResponseOverlay.swift`](CompanionResponseOverlay.swift) | Cursor-following panel streaming the answer text |
| [`OverlayWindow.swift`](OverlayWindow.swift) | Full-screen overlay cursor, navigation bubbles, overlay manager |
| [`GlideDynamicIslandManager.swift`](GlideDynamicIslandManager.swift) | Notch island UI for listening/thinking/speaking |
| [`CompanionPanelView.swift`](CompanionPanelView.swift) | Notch panel UI: settings and Composio integrations |
| [`MenuBarPanelManager.swift`](MenuBarPanelManager.swift) | Menu-bar status item toggling the island panel |
| [`OnboardingView.swift`](OnboardingView.swift) | First-launch onboarding SwiftUI flow |
| [`OnboardingWindowController.swift`](OnboardingWindowController.swift) | Temporary Dock window hosting onboarding |
| [`GlobalPushToTalkShortcutMonitor.swift`](GlobalPushToTalkShortcutMonitor.swift) | CGEvent tap for the global push-to-talk shortcut |
| [`WindowPositionManager.swift`](WindowPositionManager.swift) | Permission helpers and screen geometry |
| [`DesignSystem.swift`](DesignSystem.swift) | Colours, typography, shared SwiftUI styles |
| [`GlideAnalytics.swift`](GlideAnalytics.swift) | Opt-in PostHog telemetry (hard no-op without key + toggle) |
| [`AppBundleConfiguration.swift`](AppBundleConfiguration.swift) | Reads server URL, Clerk and related keys from Info.plist |
| [`Info.plist`](Info.plist) | LSUIElement plist: Clerk, Sparkle, mic/screen/speech usage strings |
| [`Glide.entitlements`](Glide.entitlements) | Non-sandbox entitlements: network, mic/camera, ScreenCaptureKit |
| [`enter.mp3`](enter.mp3) | UI sound effect (enter) |
| [`eshop.mp3`](eshop.mp3) | UI sound effect (notification) |

## Machine-managed artifacts

Not part of the brAIn navigation (rule 5) — linked here so nothing is orphaned.

| Artifact | Purpose |
| --- | --- |
| [`Assets.xcassets/Contents.json`](Assets.xcassets/Contents.json) | Asset catalog root |
| [`Assets.xcassets/AccentColor.colorset/Contents.json`](Assets.xcassets/AccentColor.colorset/Contents.json) | Accent colour set |
| [`Assets.xcassets/AppIcon.appiconset/Contents.json`](Assets.xcassets/AppIcon.appiconset/Contents.json) | App icon set manifest |
| [`Assets.xcassets/AppIcon.appiconset/16-mac.png`](Assets.xcassets/AppIcon.appiconset/16-mac.png) | App icon 16 px |
| [`Assets.xcassets/AppIcon.appiconset/32-mac.png`](Assets.xcassets/AppIcon.appiconset/32-mac.png) | App icon 32 px |
| [`Assets.xcassets/AppIcon.appiconset/64-mac.png`](Assets.xcassets/AppIcon.appiconset/64-mac.png) | App icon 64 px |
| [`Assets.xcassets/AppIcon.appiconset/128-mac.png`](Assets.xcassets/AppIcon.appiconset/128-mac.png) | App icon 128 px |
| [`Assets.xcassets/AppIcon.appiconset/256-mac.png`](Assets.xcassets/AppIcon.appiconset/256-mac.png) | App icon 256 px |
| [`Assets.xcassets/AppIcon.appiconset/512-mac.png`](Assets.xcassets/AppIcon.appiconset/512-mac.png) | App icon 512 px |
| [`Assets.xcassets/AppIcon.appiconset/1024-mac.png`](Assets.xcassets/AppIcon.appiconset/1024-mac.png) | App icon 1024 px |

## When to read what

| Question | Read |
| --- | --- |
| Where does everything get orchestrated? | [`CompanionManager.swift`](CompanionManager.swift) |
| How does auth work? | [`GlideAuthManager.swift`](GlideAuthManager.swift) |
| How is speech transcribed? | [`BuddyTranscriptionProvider.swift`](BuddyTranscriptionProvider.swift) |
| What telemetry exists and when? | [`GlideAnalytics.swift`](GlideAnalytics.swift) |
