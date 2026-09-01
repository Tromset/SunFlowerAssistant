# Sunflower-Code

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

The coding harness: agentic loop, sandboxed tools, transcript for the Code window.

## Files

| File | Purpose |
| --- | --- |
| [`session.ts`](session.ts) | The agentic loop: modes, permission gates, two tool dialects, compaction |
| [`tools.ts`](tools.ts) | Workdir-confined tools: read/write/edit/move/list/search/bash |
| [`transcript.ts`](transcript.ts) | In-memory transcript feeding the dedicated Code window |

## When to read what

| Question | Read |
| --- | --- |
| How does a Code turn execute? | [`session.ts`](session.ts) |
| What can the tools touch and what is refused? | [`tools.ts`](tools.ts) |
| How does the Code window get its data? | [`transcript.ts`](transcript.ts) |
