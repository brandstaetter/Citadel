# Unattended runner and worktree safety

Local schedules and daemon sessions now launch Claude with `--permission-mode default`.
They do not disable runtime permission checks. Work requiring additional permissions
must be approved through the runtime; unattended execution may therefore stop or fail.

## Local schedules

Review the cadence, project and prompt before creating a persistent OS task:

```text
node scripts/local-schedule.js add "every 30m" "/pr-watch" --confirm
node scripts/local-schedule.js list
node scripts/local-schedule.js remove citadel-01234567
```

Each new job requires its `.citadel/schedules/<id>.json` record to launch Claude.
Removing that record disables execution. Removing `.citadel` during unharnessing
therefore disables these new jobs, although their inert OS entries still require
explicit removal. Keep the returned task ID and remove the task before uninstalling
the plugin. Removing only the plugin may leave its cached source available, so
plugin uninstall alone must not be treated as schedule revocation.

Existing tasks created before this change still contain the old permission-bypassing
command. Updating Citadel does not rewrite OS tasks. Use `list`, review each task,
then `remove <id>` and recreate only the schedules still wanted. Do not bulk-delete
tasks based on a name prefix. The same exact-ID removal command supports legacy jobs.

## Local daemon

After approval of the campaign, finite budget and session limit, set
`localRunnerEnabled: true` in `.planning/daemon.json`. The runner requires a positive
finite `budget`, nonnegative `estimatedSpend`, and an active campaign. It stops on
failed execution, exhausted budget, disabled state or its session limit (default 10).
Use `--max-sessions N` for a different positive limit; zero no longer means unlimited.
Before each launch, the runner reserves `costPerSession` (default 3) in
`localEstimatedSpend`, using the larger of that reservation and `estimatedSpend`.
It refuses a session that would exceed the budget. Failed sessions are not refunded
automatically. Budget figures are estimates, not a provider-enforced spending cap.

`CLAUDE_NON_INTERACTIVE=1` alone no longer authorizes automatic continuation.
The PowerShell entrypoint delegates to the same Node runner, using the current
project directory or `CLAUDE_PROJECT_DIR` instead of a machine-specific path.

## Worktrees

Worktree creation only records readiness. It does not copy `.env` or `.env.local`,
install Node/Python dependencies, or create a virtual environment. Missing resources
remain visible in the readiness report. Prepare dependencies and any required secret
access separately through normal approval. Review package lifecycle scripts before
allowing them to execute; tracked manifests and `.gitignore` are not trust boundaries.
