# CLI entry points

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

The four executables registered by `npm link`.

## Files

| File | Purpose |
| --- | --- |
| [`sunflower.js`](sunflower.js) | Main CLI: builds if needed, launches Electron quietly, dispatches subcommands |
| [`sunflower-code.js`](sunflower-code.js) | Opens the Sunflower-Code window with the current folder as project |
| [`sunflower-models.js`](sunflower-models.js) | Interactive TUI to list, pull and select Ollama models |
| [`sunflower-requirements.js`](sunflower-requirements.js) | Checks (and `--fix`es) every line of the root `requirements.txt` |

## When to read what

| Question | Read |
| --- | --- |
| What happens when I run `sunflower`? | [`sunflower.js`](sunflower.js) |
| How does `sunflower code` pick its project folder? | [`sunflower-code.js`](sunflower-code.js) |
| How are models listed, pulled and switched? | [`sunflower-models.js`](sunflower-models.js) |
| How are requirements checked? | [`sunflower-requirements.js`](sunflower-requirements.js) |
