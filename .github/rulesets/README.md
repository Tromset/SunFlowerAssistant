# Branch rulesets

`main.json` is the rule set that protects the default branch. GitHub does not
read this directory — it is a **definition you import**, kept in the repo so the
protection is reviewable, diffable, and restorable if someone edits it in the UI.

## What it enforces

| Rule | Effect |
|---|---|
| `deletion` | `main` cannot be deleted. |
| `non_fast_forward` | no force-push to `main`; history is append-only. |
| `pull_request` | every change lands through a pull request — no direct commits. |

Inside the pull-request rule:

- **0 required approvals.** This repo has one maintainer, and the pull requests
  are opened under that same account. Requiring an approval would deadlock every
  PR, because GitHub does not let an author approve their own. The gate here is
  "it went through a PR and the diff was visible", not "someone else signed off".
- **Stale reviews are dismissed on push.** If a review does happen, a later push
  invalidates it.
- **Conversations must be resolved** before merge, so review threads can't be
  merged past.
- **Merge and squash allowed, rebase not.** The history is merge-commit based
  (`Merge pull request #NN from Tromset/claude/...`); rebase merges would break
  that shape for no gain.

No bypass actors. The maintainer is subject to the same rules — that is the
point, since the commits that skipped review so far (`a511804`, `096122d`,
`2650ea1`) were pushed straight to `main` from the web UI.

## What it deliberately does not enforce

- **`required_linear_history`** — incompatible with the merge-commit flow above.
- **`required_status_checks`** — there is no CI in this repo (see `CLAUDE.md`:
  the build is the only gate, and it runs locally). Naming a check that no
  workflow ever reports would block every merge permanently.

If a workflow is ever added that runs `pnpm check-types` — which is what runs
`scripts/check-loops.mjs`, the always-on budget check — add it to the rules:

```json
{
  "type": "required_status_checks",
  "parameters": {
    "strict_required_status_checks_policy": true,
    "do_not_enforce_on_create": false,
    "required_status_checks": [{ "context": "check-types" }]
  }
}
```

## Applying it

In the UI: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, then
upload `main.json`.

Or with the CLI, from a checkout:

```sh
gh api -X POST repos/Tromset/SunFlowerAssistant/rulesets \
  --input .github/rulesets/main.json
```

To update an existing ruleset instead of creating a second one, find its id with
`gh api repos/Tromset/SunFlowerAssistant/rulesets` and `PUT` to
`repos/Tromset/SunFlowerAssistant/rulesets/<id>` with the same file.

Changing the rules means editing `main.json` in a pull request and re-importing —
if you edit them in the UI, this file goes stale and stops being the record.
