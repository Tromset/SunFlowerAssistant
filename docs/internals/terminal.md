# The terminal interface

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [guide: terminal](../guide/terminal.md), [internals: cli-tools](cli-tools.md)

When launched from a terminal, Sunflower turns it into a first-class interface
— the same black-and-yellow, the same pixel sunflower as the windows, drawn in
the terminal itself (`main/tui.ts`, `tui-pixel.ts`, `tui-ansi.ts`; zero
dependencies, hand-rolled ANSI).

- **The banner draws the real sunflower**: the very pixel art the app renders as
  SVG (`shared/sunflower-pixels.ts`) rasterised into half-block characters
  (`▀`, one glyph carrying two pixels, doubled horizontally so pixels come out
  square) in 24-bit colour, beside a rounded status card
  (`╭─ ✿ sunflower ─── v0.1.0 ─╮`).
- **Degradation ladder**: truecolor → shape-only blocks → plain `[sunflower]`
  log lines when there is no TTY (the packaged app changes nothing else).
- **A mode badge sits in the prompt.** `ask ❯` talks to the screen companion;
  `code ❯` / `plan ❯` / `chat ❯` / `vision ❯` talk to Sunflower-Code.
- **Typing a question** takes a screenshot at your cursor and runs the exact
  same pipeline as voice — answer streams into the terminal *and* the companion
  bubble with speech. It works while Whisper is still downloading.
- **`Ctrl+C`** interrupts the current answer, the current Sunflower-Code turn
  *and* any work run; at an idle prompt it quits.

### Slash commands

| Command | What it does |
| --- | --- |
| `/help` | the command card |
| `/mode <ask\|code\|chat\|vision\|plan>` | who answers what you type |
| `/permission <plan\|normal\|yolo>` | what Sunflower-Code may do on its own |
| `/cd <folder>` | Sunflower-Code's project folder (clears the conversation) |
| `/code` | open the Sunflower-Code window |
| `/model [name]` | show or switch the local model |
| `/status` | the status card again |
| `/clear` | forget the conversation and clear the screen |
| `/work <task>` | hand a computer chore to Sunflower Work |
| `/claude [on\|off]` | the Claude Code bridge: state and live sessions, or the switch |
| `/quit` (or `/exit`) | full shutdown |
