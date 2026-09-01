# Configuration reference

> **Navigation:** [internals hub](README.md) · [brain.yaml](brain.yaml) · related: [internals: environment-variables](environment-variables.md)

`~/Library/Application Support/sunflower/config.json`, schema in
`shared/config-schema.ts`, read/written atomically by `main/config-store.ts`
(temp file + rename, cached in memory).

| Key | Default | Meaning |
| --- | --- | --- |
| `onboarded` | `false` | onboarding completed |
| `ollamaHost` | `http://localhost:11434` | overridden by the `OLLAMA_HOST` env var |
| `ollamaModel` | `qwen3-vl:8b` | falls back to the first local vision model |
| `whisperModel` | `ggml-small-q5_1.bin` | filename on `ggerganov/whisper.cpp` |
| `screenCaptureConfirmed` | `false` | a capture actually succeeded once |
| `orbY` | `0.5` | vertical position of the orb, 0–1 |
| `companionMode` | `"follow"` | `follow` \| `docked` |
| `sunflowerWorkEnabled` | `false` | **opt-in** for Sunflower Work |
| `workRequiredIdleSec` | `0` | idle seconds before the first gesture (`0` = start now) |
| `workBudgetMin` | `120` | total run budget, minutes (`0` = unlimited) |
| `workMaxSteps` | `300` | steps per run |
| `moodsEnabled` | `true` | contextual accessories |
| `claudeWatchEnabled` | `false` | **opt-in** for the Claude Code bridge |
| `claudeChimeEnabled` | `true` | the sound that goes with the ripple |
| `codePermission` | `"normal"` | `plan` \| `normal` \| `yolo` |
| `codeMode` | `"code"` | `code` \| `chat` \| `vision` \| `plan` |
| `effort` | `"medium"` | `low` \| `medium` \| `high` — generation budgets, `shared/effort.ts` |
| `effortDeadlineMin` | `0` | wall-clock cap per task, minutes (`0` = none) |

**Other paths under `~/Library/Application Support/sunflower/`:**

| Path | Contents |
| --- | --- |
| `models/` | the Whisper ggml model |
| `claude/hook.sh` | the shell hook Claude Code runs (written on enable, `0700`) |
| `claude/spool/` | one file per hook event, deleted the instant it is read |
| `claude/settings-backup.json` | `~/.claude/settings.json` as it was before the first write |
| `logs/native.log` | filtered whisper.cpp/ggml stderr, rotated at 5 MB |
| `watchdog/watchdog-YYYY-MM-DD.jsonl` | resource samples, a few days / few MB |
