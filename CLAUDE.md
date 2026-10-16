# Checkpoint

## Checking CI status

Use `scripts/ci/ci-status.mjs` to check GitHub Actions progress instead of `gh` or hand-written API calls. It reads a PAT from `GITHUB_TOKEN` (or `GH_TOKEN`), which lives in the git-ignored `.env` at the repo root.

Load the token by sourcing `.env` in the same Bash command as the script, since shell state does not persist between Bash calls. Wrap it in `set -a` / `set +a` so the variables are exported to the `node` child process even if `.env` lines lack `export`:

```sh
set -a && source .env && set +a && node scripts/ci/ci-status.mjs --json
```

Never print, echo, or log the token or the contents of `.env`, and never pass it with `--token` (it would land in the transcript).

Common invocations:

- `node scripts/ci/ci-status.mjs --json`: runs for local HEAD. Prefer `--json` when you are reading the output yourself; each job has `status`, `conclusion`, `currentStep`, and `failedSteps`, plus an `overall` field.
- `--branch main`, `--sha <sha>` (short is fine), or `--run <id>`: pick a different target.
- `--workflow <name>`: only runs whose workflow name or file contains the substring (for example `data-loss`, `test`).
- `--logs`: after the report, print the last lines of each failed job's log (`--log-lines <n>`, default 80). Use this to diagnose a failure; it is ignored with `--json`.
- `--watch --interval <sec>`: poll until every run finishes. This blocks, so run it with `run_in_background` and wait for the completion notification rather than polling in a loop yourself.
- `--remote premium` or `--repo owner/name`: check the CheckpointPremium repo or another repo instead of `origin`.

Exit codes: 0 all runs succeeded, 1 a run failed or was cancelled, 2 still in progress, 3 no runs found for the commit (usually it has not been pushed yet), 4 usage or API error (a 401 means the token in `.env` is missing or expired; ask the user to refresh it).

Run `node scripts/ci/ci-status.mjs --help` for the full option list.
