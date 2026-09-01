# Architecture

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: file-reference](file-reference.md), [internals: build-system](build-system.md)

### Repository map

```txt
apps/
  electron/   Electron screen companion "sunflower" — fully local
    bin/      sunflower, sunflower-models, sunflower-requirements CLIs
    scripts/  esbuild build, always-on budget check, native-log filter
    src/
      main/       Electron main process (Node)
      preload/    contextBridge → window.sunflower
      renderer/   one bundle per window surface (IIFE)
      shared/     types + pure logic, no electron / no node
  macos/      Native Swift/AppKit menu-bar app (earlier prototype)
  server/     Hono Cloudflare Worker API (used by the Swift app)
packages/
  config/     Shared TypeScript config (@piksy/config)
```

```mermaid
graph TB
    subgraph repo["SunFlowerAssistant (pnpm workspace + turborepo)"]
        subgraph electron["apps/electron — 'sunflower'"]
            E_main["src/main<br/>Electron main process"]
            E_pre["src/preload<br/>contextBridge"]
            E_rend["src/renderer<br/>7 window surfaces"]
            E_shared["src/shared<br/>pure types + logic"]
            E_bin["bin/<br/>3 CLIs"]
        end
        subgraph macos["apps/macos — 'Glide' (prototype)"]
            M_app["Swift / AppKit / SwiftUI"]
        end
        subgraph server["apps/server — Hono Worker"]
            S_routes["routes: chat, models, tts,<br/>transcribe-token, integrations"]
        end
        pkg["packages/config<br/>tsconfig.base.json"]
    end

    ollama[("Ollama<br/>localhost:11434")]
    whisper[("whisper.cpp<br/>ggml-small-q5_1")]
    hosted["Hosted services<br/>Clerk · AssemblyAI · Gradium · Composio"]

    E_main --> ollama
    E_main --> whisper
    E_main <--> E_pre <--> E_rend
    E_main --> E_shared
    E_rend --> E_shared
    E_bin --> ollama

    M_app --> S_routes
    S_routes --> ollama
    S_routes --> hosted
    M_app --> hosted

    pkg -.-> electron
    pkg -.-> server
```

### Two implementations, one idea

```mermaid
flowchart LR
    subgraph localtrack["Electron track — 100% local"]
        direction TB
        L1["hold ⌃⌥"] --> L2["mic capture<br/>renderer/island"]
        L2 --> L3["whisper.cpp<br/>local transcription"]
        L3 --> L4["desktopCapturer<br/>screenshot"]
        L4 --> L5["Ollama /api/chat<br/>vision model"]
        L5 --> L6["speech bubble +<br/>macOS system voice"]
    end

    subgraph hostedtrack["Swift track — hosted helpers"]
        direction TB
        H1["hold push-to-talk"] --> H2["AssemblyAI<br/>realtime transcription"]
        H2 --> H3["ScreenCaptureKit"]
        H3 --> H4["Worker /chat →<br/>Ollama via AI SDK"]
        H4 --> H5["Gradium TTS"]
    end
```

The Electron app needs **no server, no Clerk, no API keys**. The Swift app
needs a running Worker and a Clerk application; every one of its routes is
authenticated.

### Electron process topology

Seven renderer surfaces, all created by the main process. Overlays are
transparent, click-through, always-on-top and **excluded from Sunflower's own
screenshots** via `setContentProtection(true)` (`main/windows/common.ts`).

```mermaid
graph TD
    main["main process<br/>src/main/index.ts"]

    subgraph overlays["Overlay windows (transparent, click-through, content-protected)"]
        island["island<br/>560×110, under the notch<br/>status + mic capture"]
        companion["companion<br/>480×220 → 110×110 docked<br/>flower + speech bubble"]
        pointer["pointer<br/>adaptive bracket frame"]
        orb["orb<br/>docked to the right edge"]
    end

    subgraph windows["Regular windows"]
        panel["menu-bar panel<br/>home · work · code"]
        work["Sunflower Work app<br/>3 columns"]
        code["Sunflower-Code app<br/>3 columns"]
        onboard["onboarding<br/>3 steps, first launch only"]
    end

    tray["Tray (menu bar icon)"]
    tui["Terminal UI<br/>same process, stdout/stdin"]

    main --> island
    main --> companion
    main --> pointer
    main --> orb
    main --> panel
    main --> work
    main --> code
    main --> onboard
    main --> tray
    main --> tui
```

| Surface | Window type | Visibility rule |
| --- | --- | --- |
| `island` | overlay, 560×110, centred under the notch | hidden at `idle`, shown on any other state, 2 s grace before hiding |
| `companion` | overlay, 480×220 (110×110 docked) | always visible after onboarding; click-through except over the flower |
| `pointer` | overlay, resizable | 4 s per frame (`POINTER_MS`), or sticky during a guide |
| `orb` | overlay, focusable | only while a code session or work run is busy |
| `panel` | popover anchored to the tray | toggled by the tray click; self-sizes to its card height |
| `work` / `code` | regular windows | opened on demand; closing hides, state survives |
| `onboarding` | regular window | first launch only (`onboarded: false`) |

### The IPC contract

Every channel name lives in `shared/ipc.ts` under the `CH` constant, and the
whole renderer-visible surface is the `SunflowerBridge` interface exposed by
`preload/index.ts` as `window.sunflower`. Renderers have
`contextIsolation: true`, `nodeIntegration: false` — no direct Node access.

```mermaid
graph LR
    subgraph mainp["main process"]
        m["ipcMain"]
    end
    subgraph pre["preload"]
        b["window.sunflower<br/>SunflowerBridge"]
    end
    subgraph rend["renderers"]
        r["island · companion · panel<br/>pointer · orb · work · code"]
    end

    m -- "webContents.send: state, answerToken,<br/>panelData, orbChanged, workEvent,<br/>codeEvent, activity, guideStep…" --> b
    b -- "on(…) subscriptions" --> r
    r -- "invoke: getStatus, setConfig,<br/>orbOpen, workStart, codeSend,<br/>codeApprove, quit…" --> b
    b -- "ipcRenderer.invoke / send" --> m
```

Channel families:

| Prefix | Direction | Purpose |
| --- | --- | --- |
| `sf:state`, `sf:answer-*`, `sf:point-show`, `sf:guide-step`, `sf:tts-*` | main → renderer | the live session |
| `sf:mic-*` | both | mic start/stop commands, PCM data back |
| `sf:panel-data`, `sf:activity` | main → renderer | status card, mood snapshot |
| `sf:orb:*` | both | the right-edge orb: status, hover, drag, click |
| `sf:work:*` | both | Sunflower Work sessions |
| `sf:code:*` | both | Sunflower-Code (single shared session — **no session id in any method**) |
| `sf:permissions:*`, `sf:config:*`, `sf:whisper:*`, `sf:app:quit` | renderer → main | setup and lifecycle |
