---
title: "intake-scanner counts unknown statuses (closed, deferred) as pending"
status: completed
priority: normal
target: hooks_src/intake-scanner.js
---

## Description

The SessionStart hook `hooks_src/intake-scanner.js` and the dashboard
(`scripts/dashboard.js` `countPendingIntakeItems`) disagree on intake counts.
The dashboard is correct; the hook over-reports.

Observed in a consuming project (AgentSandbox, 2026-10-09):

- SessionStart hook printed: `3 pending`, `15 in progress`.
- `/do status` dashboard printed: `Intake items: 0 in .planning/intake/`.
- Actual frontmatter statuses (31 items, excluding `_TEMPLATE.md`):
  13 `completed`, 15 `briefed`, 2 `closed`, 1 `deferred`, 0 `pending`.

### Root cause

`hooks_src/intake-scanner.js:102-103`:

```js
const statusMatch = content.match(/^status:[ \t]*(pending|in-progress|briefed|completed|archived)[ \t]*$/m);
const status = statusMatch ? statusMatch[1] : 'pending';
```

Any status outside that closed list (here `closed`, `deferred`) fails the
regex and falls back to `'pending'`. The 3 "pending" were exactly the 2
`closed` + 1 `deferred` items, reported as new work when they are terminal or
parked.

Secondary issues in the same lines:

1. The regex is multiline over the **whole file**, not the frontmatter, so a
   body line beginning `status: completed` (e.g. a quoted example) can
   determine the status. The dashboard uses `parseFrontmatter`; the hook
   should read only the frontmatter block too.
2. A missing status line defaults to `pending`. That default matches the
   dashboard (`frontmatter.status || 'pending'`) and should stay. Only
   *present but unrecognised* values are the bug.

`briefed` -> "in progress" (line 118) is intentional and out of scope, though
the dashboard does not surface briefed items at all; note the asymmetry in the
PR if you touch it.

## Proposed fix

- Parse the status from the frontmatter only (reuse the dashboard's
  frontmatter parsing, or an equivalent minimal parser; the hook must stay
  dependency-light and fast).
- Normalise case/whitespace like the dashboard (`toLowerCase()`).
- Classify:
  - missing -> `pending` (unchanged)
  - `pending` -> pending
  - `in-progress`, `briefed` -> in progress
  - `completed`, `archived`, `closed`, `deferred`, `rejected`, `cancelled` -> skip
  - any other present value -> skip (do **not** count as pending); optionally
    count as "unrecognised" in metadata only.
- Keep the counts-only output contract: titles, filenames and raw status
  strings are untrusted repository content and must not be echoed into the
  SessionStart text or structured metadata (see the comment near line 124 and
  `scripts/test-session-safety.js`).
- Ideally share one classifier between the hook and the dashboard so they
  cannot drift again.

## Acceptance Criteria

- An intake dir containing only `closed`, `deferred`, `completed`, `archived`
  and an unknown status (e.g. `status: wontfix`) produces **no** pending count
  from the hook.
- A file with no `status:` line still counts as pending (in both hook and
  dashboard).
- A file whose frontmatter says `status: pending` but whose body contains a
  line `status: completed` counts as pending.
- `Status: Pending` (case variant) counts as pending in both hook and dashboard.
- Hook and dashboard report the same pending count for the same directory.
- `scripts/test-session-safety.js` (count-only intake check) still passes;
  add the cases above to it or a dedicated test.
- No titles, filenames or status strings appear in hook output.

## Context

- Reporter: AgentSandbox session, 2026-10-09. No change was made on the
  AgentSandbox side; its intake files keep their `closed`/`deferred` statuses
  as a live regression fixture.
- Other references to the hook: `core/config/bundle-catalog.js`,
  `scripts/verify-hooks.js`, `scripts/test-backward-compat.js`,
  `scripts/release-package.js`, `scripts/test-release-integrity.js`.
- The Citadel main checkout currently has unrelated uncommitted work; branch
  or use a worktree before editing.

## Resolution

- 2026-10-09: Implemented on branch `fix/intake-scanner-status` (worktree
  `.worktrees/intake-scanner-status`, based on `origin/main`); committed as
  7797d2d, PR https://github.com/SethGammon/Citadel/pull/338. Mark completed
  when merged.
- New `core/intake/status.js` holds the shared file filter and frontmatter-only,
  case-insensitive classifier; both `hooks_src/intake-scanner.js` and
  `scripts/dashboard.js` use it. Unrecognised statuses go to
  `unrecognisedCount` metadata only. Added to `release-files.json`.
- Dashboard file selection now matches the hook (skips all `_`/`.`-prefixed
  files, not just `_TEMPLATE.md`). Briefed items are still not surfaced by the
  dashboard (asymmetry unchanged, as scoped).
- Acceptance cases added to `scripts/test-session-safety.js`; they fail on the
  old hook. Full aggregate, verify-hooks (100/100) and integration (20/20) pass
  with `CITADEL_RUNTIME` unset; with it set, two runtime-detection tests fail
  on `main` until the `gh-copilot` commit 2296407 lands.
