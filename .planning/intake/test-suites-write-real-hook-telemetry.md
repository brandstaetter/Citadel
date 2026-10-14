---
title: "Stop test suites from writing synthetic hook blocks into real telemetry"
status: completed
priority: normal
target: scripts/
---

## Description

Running the test suites locally appends synthetic hook blocks to the checkout's real
`.planning/telemetry/hook-errors.jsonl`. Examples are `Edit ../../../etc/passwd`, `Write /etc/passwd`,
`cat .env.local`, `gh release create v1.0.0` and `git push origin --delete main`. On 2026-10-12, 497 of the
1,310 records in this checkout's `hook-errors.jsonl` matched those payloads.

Cause: `scripts/test-security.js` spawns `hooks_src/protect-files.js` (and other hooks) with
`cwd: PLUGIN_ROOT` and the inherited environment, e.g. `scripts/test-security.js:64-74`. The hooks resolve
`PROJECT_ROOT` as `process.env.CLAUDE_PROJECT_DIR || process.cwd()` (`hooks_src/harness-health-util.js:15`),
and `logBlock()` appends to `<PROJECT_ROOT>/.planning/telemetry/hook-errors.jsonl`. Inside an agent session,
`CLAUDE_PROJECT_DIR` points at the real checkout, and outside one `cwd` does. Either way the writes land in
real telemetry. Some cases in the same file already use a temporary `CLAUDE_PROJECT_DIR` (lines 137-162),
so the pattern is inconsistent rather than missing.

Effect: the dashboard's problem taxonomy and `/telemetry` count these entries as real safety blocks, which
hides genuine blocks among test noise. The hash-chained telemetry also accumulates records that never came
from a real session.

Other suites that contain the same payloads and may leak the same way: `scripts/test-policy-core.js`,
`scripts/test-dashboard.js`, `scripts/experiment-safety-gates.js`. Check each one, and check any suite that
spawns hooks, such as `verify-hooks.js`, `integration-test.js` and `hooks_src/smoke-test.js`.

## Acceptance Criteria

- Every test that spawns a hook runs it against a temporary project root: `CLAUDE_PROJECT_DIR` and `cwd`
  both point at a `mkdtemp` directory that is removed afterwards. Ideally a shared helper does this, so new
  tests can't regress.
- A regression check: record the size and hash of the checkout's `.planning/telemetry/*.jsonl` before
  `node scripts/test-all.js --strict` and compare after the run. They are unchanged, both with and without
  `CLAUDE_PROJECT_DIR` set to the checkout.
- `test-all --strict`, `smoke-test`, `verify-hooks` and `integration-test` still pass.
- Optional: document how to clean already-leaked entries without breaking the telemetry hash chain, or
  decide that the dashboard ages them out as stale.

## Resolution (2026-10-12)

Built on branch `fix/test-telemetry-isolation` (worktree `.worktrees/test-telemetry`), commit `ef2da1b`, from `main` 6d0684b.
Pushed to `mine`; PR #346: https://github.com/SethGammon/Citadel/pull/346

A per-suite scan of every suite in `test-all.js` plus `verify-hooks` and `integration-test` found five leaks:
- `test-security.js`, `test-codex-runtime.js`: hook blocks into `hook-errors.jsonl`. Fixed with a temporary project.
- `test-run-with-timeout.js`, `test-codex-package-closure.js`: `last-command-result.json`. Fixed by pinning
  `CLAUDE_PROJECT_DIR`. Inside a session, `test-run-with-timeout` also failed outright.
- `verify-hooks.js`: `audit.jsonl` and `hook-timing.jsonl`, through an in-process `require()` of
  `harness-health-util`. Those audit tests passed falsely; they now load the module bound to the sandbox and
  assert the record they wrote.

`test-policy-core.js` and `test-dashboard.js` only contain the payload strings and did not leak.
`test-governed-lifecycle-usecases.js` writes `.planning/verification/governed-lifecycle.json` on purpose (a
gitignored proof report), so it was left alone.

Verified: `test-all --strict`, `smoke-test`, `verify-hooks` and `integration-test` pass, and
`.planning/telemetry/` is unchanged, with and without `CLAUDE_PROJECT_DIR` set to the checkout.
Not done: cleaning entries that already leaked (optional criterion). They age out of the dashboard as stale.
