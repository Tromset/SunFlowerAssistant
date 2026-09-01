# Chat helpers

> **Navigation:** [parent hub](../README.md) · [brain.yaml](brain.yaml)

Payload conversion and prompt construction for `/chat`.

## Files

| File | Purpose |
| --- | --- |
| [`messages.ts`](messages.ts) | Converts chat payloads into AI SDK messages, extracts user text |
| [`instructions.ts`](instructions.ts) | Builds pointing/agent system prompts and toolkit intent heuristics |

## When to read what

| Question | Read |
| --- | --- |
| How is the system prompt built? | [`instructions.ts`](instructions.ts) |
| How are client messages converted? | [`messages.ts`](messages.ts) |
