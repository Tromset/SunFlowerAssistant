# Sunflower-Code — the coding harness

> **Navigation:** [guide hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: sunflower-code](../internals/sunflower-code.md), [guide: terminal](terminal.md)

The terminal isn't only a question box. `/mode code` (or `chat`, `vision`, `plan`) routes **everything you type** to **Sunflower-Code**, a port of [Ollama-Code](https://github.com/Tromset/Ollama-Code)'s infrastructure living inside sunflower and running against the same local Ollama. There is exactly one entry point — `routeToCode()` in `main/index.ts` — so there is exactly one place to look to know where a message went.

**Four modes**, same names as the original: `code` (the full workshop), `chat` (no tools at all), `vision` (same as code, with a screenshot of your screen attached to the message), `plan` (read-only: investigate, then write out the plan).

**Seven tools**, all confined to one project folder — `read_file`, `write_file`, `edit_file`, `move_file`, `list_files`, `search`, `bash`. An absolute path, a `..`, or a filename that looks like a secret (`.env`, `.npmrc`, `id_rsa`…) is refused before anything is opened; `bash` runs with its working directory locked to that folder and goes through a non-bypassable blacklist (`main/shell-guard.ts` — `rm -rf`, `sudo`, force pushes, piping downloads into a shell…). `/cd` moves the folder.

**Three permission levels**, `/permission`:

| Level | Reads | Writes and shell |
| --- | --- | --- |
| `plan` | free | refused outright |
| `normal` *(default)* | free | each one waits for `y`, `n` or `a` at the prompt |
| `yolo` | free | no questions asked |

The mode can restrict further but never widen: `plan` mode is read-only even under `yolo`, and `chat` exposes no tools at all whatever the level.

`a` at an approval prompt means **always allow this exact action** — same tool, same arguments — for the rest of the session. It generalises nothing: approving `bash npm test` once and for all does not approve `bash`, and certainly not `bash rm -rf`. The rule is dropped when you `/clear`, change permission level, or change project folder.

**Two tool dialects, one code path.** Small local models are not equal in front of function calling, so Sunflower-Code asks Ollama (`/api/show`) whether the model advertises `tools`. If it does, the native tool interface is used. If it doesn't, the prompt describes a text protocol instead — one fenced ```tool block holding `{"name": …, "args": {…}}` — and the parser turns it into the same call object. Nothing downstream knows which one served.

**The context renews itself.** Past a token budget the session is *compacted*: the original request, the tools already run and the last answer are folded into a short local summary (no extra model round-trip), and the conversation restarts from a fresh window. That's what makes a long refactor survivable on an 8B model. If the model asks for more tool calls than a turn allows, it's told so explicitly rather than silently truncated.

**The Sunflower-Code app.** The harness now has a window of its own, the same kind Sunflower Work has — `code ↗` in the menu-bar panel, `sunflower code` from a terminal, or `/code` at the prompt. It is **the same session as the terminal's**, not a second one: a question typed at `code ❯` appears in the window as it streams, a message sent from the window comes out in the terminal, and `/mode`, `/permission` and `/cd` move the app's controls the moment you type them (and the other way round). One conversation, two places to watch it — which is also why the composer greys out while a turn is in flight: one turn at a time is the truth, not a limitation of the window.

Three columns, and they say what a coding harness actually is:

- **left — what it may do**: mode and permission as pills, the project folder, and the live gate for all seven tools (`free` / `asks you` / `refused`, greyed out when the mode doesn't expose them at all). Not a restatement of the table above — the same `gateFor`/`toolsFor` the harness itself calls, so `plan` under `yolo` visibly closes every write. Under it, the turn and token meters against the real ceilings (24 turns, 12k tokens) and the compaction count.
- **middle — what it is saying**: the conversation, with the answer streaming into a live bubble, tool calls inline (`▸ read_file src/x.ts` → `✓ 42 lines · … 12ms`), raw command output in its own block, and a rule where the context renewed itself. Tabs split out the bare tool-call list and a plain terminal view. A tool waiting for permission raises a banner **pinned above the composer** so it cannot scroll out of sight — with, for an `edit_file`, the diff of what it is about to do, *before* you allow it. Answer in the terminal instead and the banner clears itself; click in the window and the terminal's prompt comes back. A click that lands on an approval already settled elsewhere does nothing, rather than answering the next one.
- **right — what it changed**: every file written this session, newest first, with a real before/after diff. `write_file` re-reads the file just before overwriting it and `edit_file` already held both sides, so this costs one `readFileSync` and nothing crosses the IPC boundary but the diff itself — never the file contents.

Closing the window hides it; the session keeps running in the terminal and reopening finds the whole transcript, including everything that happened while it was shut. The window costs nothing at rest: no timer, no poll, no `requestAnimationFrame` — every pixel of it moves because an event arrived, and the "thinking" pulse is a CSS animation (see the always-on budget in `CLAUDE.md`).
