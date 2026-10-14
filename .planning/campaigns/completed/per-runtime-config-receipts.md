---
version: 1
id: "da77bc59-f077-4b7d-a984-838b9887321b"
status: completed
started: "2026-10-12T09:42:33Z"
completed_at: null
direction: "URGENT: give each runtime its own effective-config receipt so Claude Code, Codex, Copilot, and OpenCode sharing one repository never see each other's receipt as stale"
phase_count: 5
current_phase: 5
branch: "fix/per-runtime-config-receipts"
worktree_status: active
orchestrator: archon
priority: urgent
reversibility: amber
estimated_sessions: 1
---

# Campaign: Per-Runtime Config Receipts

Status: completed
Priority: URGENT
Started: 2026-10-12T09:42:33Z
Direction: There is only one config receipt per repository. When Claude Code and Codex
both work in the same repository, the receipt is always stale for one of them. Fix this.

## Problem

`core/config/receipt.js` writes a single receipt to `.citadel/effective-config.json`
(`effectiveConfigPath`, line ~275). `readEffectiveConfig` rejects it as `stale` when any
of these differ from the active session:

1. `runtime.id` / `runtime.contractDigest`: this is the bug. Each runtime's receipt
   overwrites the other's.
2. `installationGeneration`: a Claude plugin install and a Codex plugin install can be
   different Citadel versions or source trees, so one shared receipt cannot match both.
3. `sourceDigest` of `.claude/harness.json`: `hooks_src/session-end.js:426` rewrites
   `harness.json` (trust counters) on **every** session end. It then reconciles only the
   active runtime's receipt, so every other runtime's receipt goes stale.

The ping-pong: a Claude session ends and `session-end` reconciles the receipt for Claude.
The next Codex session sees runtime `claude-code` against active `codex`, gets
`EFFECTIVE_CONFIG_STALE`, and activation blocks or degrades. A Codex reconcile then breaks
Claude, and the cycle repeats. `loadActivationContext` (`core/config/index.js`) only
bootstraps on `MISSING`, never on `STALE`, so nothing self-heals.

Related: the issue #322 worktree (`brandstaetter-issue-322-effective-config-stale-recurs-every-sess-*`)
probably covers cause 3. Read it in phase 1 and fold it in or stay compatible with it.

## Success Contract

- Each runtime has its own receipt. Reconciling runtime A never changes, deletes, or
  invalidates runtime B's receipt.
- Alternating sessions (claude-code → codex → claude-code → copilot → codex) with no
  user config change report `current` for each runtime every time, starting from the
  second session.
- Session-end bookkeeping (trust counters) does not make any runtime's receipt stale.
- A real user edit to `harness.json` still makes every runtime's receipt stale until that
  runtime reconciles. Staleness detection keeps working.
- Existing single-receipt repos migrate with no manual step. A legacy
  `.citadel/effective-config.json` whose runtime matches is adopted. One that does not
  match is ignored, not reported as stale.
- `repairCommand`, health output, dashboard, setup, and `/unharness` all point to the
  correct per-runtime path.

## Non-Goals

- Changing the receipt schema fields, digest algorithm, or validation rules beyond what
  the per-runtime split needs.
- Making one runtime reconcile another runtime's receipt. Each runtime has its own
  installation root, so cross-runtime reconcile would write a wrong `installationGeneration`.
- Committing receipts to git. `.citadel/*` stays ignored.
- Pushing, publishing, or tagging.

## Recommended Design (phase 1 confirms or amends)

- **Path:** `.citadel/effective-config/<runtime-id>.json`. Runtime ids already match
  `/^[a-z0-9-]+$/`; reject anything else. `effectiveConfigPath(root, { runtime })` takes
  the runtime, and an explicit `options.effectiveConfigPath` still overrides it.
- **Legacy read:** if the per-runtime file is missing and the legacy
  `.citadel/effective-config.json` exists with `runtime.id` equal to the active runtime,
  treat it as that runtime's receipt and migrate it on the next reconcile. A legacy file
  for a different runtime counts as `missing` for the active runtime (so the bootstrap
  path applies), never `stale`. Remove the legacy file only after every runtime it could
  serve has migrated, or simply leave it as an orphan until `/unharness` removes it.
  Choose one and log the choice.
- **Volatile config:** exclude runtime-mutated bookkeeping (`trust.*` counters, and any
  other field `session-end` or hooks write automatically) from `sourceDigest`. The
  better alternative is to move those counters out of `harness.json` into
  `.planning/telemetry/`. Pick one and log it.
- **Callers:** every `effectiveConfigPath(PROJECT_ROOT)` call that has no runtime
  (`hooks_src/session-end.js:427`, `hooks_src/harness-health-util.js:616`) must pass the
  detected runtime.

## Claimed Scope

- core/config/receipt.js
- core/config/index.js
- core/config/source.js
- core/config/activation.js
- core/worktree/readiness.js
- hooks_src/session-end.js
- hooks_src/init-project.js
- hooks_src/harness-health-util.js
- scripts/citadel-config.js
- scripts/install-hooks.js, scripts/install-hooks-codex.js, scripts/install-hooks-copilot.js, scripts/copilot-install.js
- scripts/dashboard.js, scripts/dashboard-server.js, scripts/route-preview.js
- scripts/test-config-activation.js, scripts/test-config-consumers.js, scripts/test-config-policy.js, scripts/test-version-upgrades.js, scripts/integration-test.js, scripts/verify-hooks.js
- unharness / adoption receipt ownership lists (wherever `.citadel/effective-config.json` is declared as owned material)
- docs/architecture/runtime-contract.md, docs/SETUP_REFERENCE.md, INSTALL.md, skills/setup/SKILL.md

## Phases

| # | Status | Type | Phase | Done When |
|---|--------|------|-------|-----------|
| 1 | complete | research | Write a failing multi-runtime regression test and confirm the design | `scripts/test-config-activation.js` has an alternating-runtime case (claude-code → codex → claude-code, plus session-end trust write) that FAILS on current code. Decision Log records path layout, legacy handling, volatile-field strategy, and the #322 relationship. |
| 2 | complete | build | Per-runtime receipt paths and legacy migration in `core/config/receipt.js` and `index.js` | The phase 1 regression test passes for runtime alternation. Legacy-matching and legacy-mismatching cases are covered and pass. `node scripts/test-all.js` exits 0. |
| 3 | complete | build | Stop session-end bookkeeping from making other runtimes stale | The regression case with a session-end `trust` write between runtimes passes. A real user edit to `harness.json` still yields `stale` for every runtime (test). `node hooks_src/smoke-test.js` exits 0. |
| 4 | complete | wire | Update every caller, installer, health/dashboard surface, unharness ownership, and the docs | `grep -rn "effectiveConfigPath(PROJECT_ROOT)" hooks_src scripts` returns no runtime-less calls. Unharness/adoption tests cover `.citadel/effective-config/`. Docs name the per-runtime path. `node scripts/test-all.js` exits 0. |
| 5 | complete | verify | Full pipeline verification | `node scripts/test-all.js --strict`, `node scripts/verify-hooks.js`, and `node scripts/integration-test.js` all exit 0. A manual run of `citadel-config reconcile --runtime claude-code` then `--runtime codex` in a scratch repo leaves two files, and each reports `current`. |

## Phase End Conditions

| 1 | command_passes | node scripts/test-config-activation.js (new alternating-runtime case fails on HEAD; record the failure output) |
| 2 | command_passes | node scripts/test-config-activation.js (exit 0) |
| 2 | command_passes | node scripts/test-all.js (exit 0) |
| 3 | command_passes | node hooks_src/smoke-test.js (exit 0) |
| 3 | command_passes | node scripts/test-config-activation.js (exit 0) |
| 4 | command_passes | node scripts/test-all.js (exit 0) |
| 5 | command_passes | node scripts/test-all.js --strict (exit 0) |
| 5 | command_passes | node scripts/verify-hooks.js (exit 0) |
| 5 | command_passes | node scripts/integration-test.js (exit 0) |

## Exit Evidence

| Target | ID | Type | Required | Evidence | Status | Retries Remaining | Next Action |
|---|---|---|---|---|---|---|---|
| phase:1 | red-test | test_result | yes | alternating-runtime case fails on HEAD | pass | 2 | write test |
| phase:2 | green-test | test_result | yes | node scripts/test-config-activation.js | pass | 2 | implement per-runtime paths |
| phase:5 | full-suite | command_result | yes | node scripts/test-all.js --strict | pass | 2 | run after wiring |

## Risks

- **Shallow clone:** the `Freeze dependency closure` check in `test-all.js` fails on
  shallow clones. Run `git fetch --unshallow` first if it does.
- **Dirty working tree:** the current `gh-copilot` branch has many uncommitted changes.
  Start this campaign in a fresh worktree from `main` so the fix ships on its own.
- **`installationGeneration` file list:** `receipt.js` is listed in
  `INSTALLATION_SOURCE_FILES`, so editing it invalidates every existing receipt once. That
  is expected. Mention it in the release notes.

## Feature Ledger

| Feature | Status | Phase | Notes |
|---------|--------|-------|-------|
| Red regression tests (runtime alternation, trust bump, override, legacy migration) | built | 1 | Failed on HEAD 6678bbb: both runtimes resolved to `.citadel/effective-config.json` |
| Per-runtime receipt path `.citadel/effective-config/<runtime-id>.json` | built | 2 | `core/config/receipt.js`: `receiptRuntimeId`, `locateReceipt`, `retireLegacyReceipt` |
| Legacy receipt migration | built | 2 | Owner reads legacy file as current; others see `missing` (bootstrap); owner's reconcile retires it |
| Trust counters excluded from `sourceDigest` | built | 3 | `core/config/source.js` `digestInput`; `trust.override` and invalid counters still count |
| Hook callers pass runtime | wired | 4 | `session-end.js`, `harness-health-util.js` |
| Docs | wired | 4 | runtime-contract.md, SETUP_REFERENCE.md, INSTALL.md, skills/setup/SKILL.md |
| Verification | passed | 5 | test-all --strict 0, smoke 0, verify-hooks 100/100, integration 0, scratch-repo CLI e2e: both runtimes current |

## Decision Log

- 2026-10-12: Campaign opened as URGENT. Root causes identified: (1) one receipt path
  for all runtimes, (2) per-runtime `installationGeneration`, (3) `session-end` rewrites
  `harness.json` on every session and reconciles only the active runtime. Cross-runtime
  reconcile was rejected because the other runtime's installation root is unknown.
- 2026-10-12: Worktree `.worktrees/per-runtime-config-receipts` on
  `fix/per-runtime-config-receipts` from clean `main` (6678bbb) is the phase checkpoint.
  Phases were executed inline by the orchestrator (Marshal fallback) because the change
  was small and tightly coupled.
- 2026-10-12: #322 is closed. Its fix (session-end reconciles the active runtime) covers
  same-runtime staleness only; this campaign covers the cross-runtime case.
- 2026-10-12: Path layout `.citadel/effective-config/<runtime-id>.json`. Runtime id
  must match `/^[a-z0-9][a-z0-9-]*$/i` and is lowercased. An explicit
  `effectiveConfigPath` option still overrides it.
- 2026-10-12: Legacy handling: the legacy shared file is read only by the runtime
  recorded in it. Another runtime gets `missing`, never `stale`, so bootstrap applies.
  The owner retires the legacy file after a successful reconcile. Any runtime may
  retire an unreadable legacy file.
- 2026-10-12: Volatile fields: the resolver never reads `trust`. Valid non-negative
  integer counters (v2 camelCase or v1 snake_case, by `schemaVersion`) and
  `override: null` are excluded from `sourceDigest`. A non-null `trust.override` and
  invalid counters stay in, because they change validation or behavior. Moving the
  counters out of `harness.json` was rejected as a larger migration.
- 2026-10-12: Adoption and unharness never tracked the derived receipt, so no
  ownership change was needed. The phase validator failed phase 4 on this first,
  because it was asserted rather than shown. Retry 1 added a `--legacy-apply` case to
  `scripts/test-unharness-governed.js` covering per-runtime and pre-split receipts, and
  the validator then passed. Governed leave keeps the derived receipt as unowned
  material in both layouts. That behavior is unchanged; whether it should delete
  derived receipts is a separate follow-up (the validator recommended an Arbiter review).
- 2026-10-12: Line endings, at the user's request during the campaign: the index was
  already LF, apart from mixed `scripts/verify-hooks.js`. System
  `core.autocrlf=true` checked everything out as CRLF, which fought byte-wise drift
  checks. `.gitattributes` now has `* text=auto eol=lf` plus explicit binary types,
  replacing the per-path pins. A repo-local `core.autocrlf=false` was tried and
  reverted: config is shared by every worktree, and branches without the new attribute
  would show about 2000 phantom modifications. The attribute alone overrides autocrlf.
  There are no CRLF exceptions: the `.ps1` scripts are LF in the index and run fine.
  The worktree and the main checkout were converted in place to LF without content
  changes. Commit the line-ending change separately from the receipt fix.
- 2026-10-12: Changed existing tests that pinned the old behavior:
  test-config-activation (path; codex receipt read as claude-code is now MISSING;
  a receipt copied under the wrong runtime path is still STALE), test-config-consumers
  (the stale preview reads as the reconciling runtime), and verify-hooks (session-end
  must leave the digest unchanged and keep both runtimes current).
- 2026-10-12: Out of scope, follow-up: two installs of the same runtime (for example
  Claude dev hooks from `hooks_src/` plus user-scope plugin 1.4.3) still share one
  receipt and disagree on `installationGeneration`. Seen in this repo.

## Continuation State

All five phases are verified and the phase validator passed (after one retry). The
policy-enforcer allowed the push and the PR.
- Commits on `fix/per-runtime-config-receipts`: `bbf3e0d` (chore: normalize line
  endings to LF) and `cb281cc` (fix(config): keep one effective-config receipt per
  runtime).
- Pushed to `mine` (brandstaetter/Citadel).
- PR: https://github.com/SethGammon/Citadel/pull/344

- First CI run failed on Windows: `applyPlan` resolved the receipt path without a
  runtime. Local runs passed because the session exports `CITADEL_RUNTIME`. Fixed in
  `e592d27`. Verify with the runtime environment variables unset from now on.
- Added `c6a3ffa`: repair and enable commands now target the checking installation
  instead of blindly using the `plugin-root.txt` delegate. That delegate is what made
  the hook's own repair hint unable to clear the block in this repo.

Next: watch CI and review on #344 (`/pr-watch 344`). After merge, rebase `gh-copilot`,
move this campaign to `completed/`, and remove the worktree.

## Completion Record

- Completed At: 2026-10-12T20:36:26.705Z
- Outcome: archived-completion
