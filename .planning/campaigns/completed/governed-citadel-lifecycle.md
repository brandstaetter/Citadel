---
version: 1
id: "6f2b9c4e-1d7a-4e58-9b3f-2a8c5d0e7f41"
status: completed
started: "2026-07-30T00:00:00.000Z"
completed_at: "2026-07-30T21:46:34.000Z"
direction: "Implement the governed Citadel lifecycle: fail-honest governance, versioned profiles and bundles, receipt-owned adoption and exit, Governance Port alpha, Real User Proof v2, and real-use proof preparation."
phase_count: 8
current_phase: 7
branch: null
worktree_status: null
---

# Campaign: Governed Citadel Lifecycle

Status: completed
Started: 2026-07-30
Direction: Implement the governed Citadel lifecycle report and architecture without overwriting unrelated dirty work.

## Direction

Implement `.planning/research/fleet-governed-citadel/REPORT.md` and
`.planning/architecture-governed-citadel-lifecycle.md` without overwriting
unrelated dirty work. Deliver fail-honest governance, versioned profiles and
bundles, receipt-owned adoption and exit, an alpha external Governance Port,
Real User Proof v2, integrated truthful product surfaces, and executable
real-use proof preparation.

## Phases

| # | Phase | Status | Validator retries remaining | Done When |
|---|---|---|---:|---|
| 0 | Baseline and ownership | complete | 3 | Branch/status/shared diffs recorded; 180-second aggregate baseline recorded as inconclusive |
| 1 | Contract kernels | complete | 3 | `node scripts/test-governance-contracts.js` and `node scripts/test-config-policy.js` pass |
| 2 | Governed adoption | complete | 3 | `node scripts/test-adoption-lifecycle.js` passes |
| 3 | Progressive activation | complete | 3 | disabled/degraded/legacy integration cases pass |
| 4 | Governance Port alpha | complete | 3 | `node scripts/test-control-plane.js` passes |
| 5 | Real User Proof v2 | complete | 3 | `node scripts/test-product-proof-v2.js` passes |
| 6 | Product integration and consistency | complete | 3 | focused existing suites, skill lint, hook suites, full aggregate suite, and `git diff --check` pass |
| 7 | Real-use proof preparation | complete | 3 | `node scripts/test-governed-lifecycle-usecases.js` passes and emits durable proof records |

## Exit Evidence

| Target | Gate | Type | Required | Evidence | Status | Attempts | Repair |
|---|---|---|---|---|---|---:|---|
| phase:1 | contract kernels | test_result | yes | governance contracts pass; config policy 21/21 pass | passed | 1 | none |
| phase:2 | adoption | test_result | yes | lifecycle 10/10, evolution 12/12, governed unharness and package CLI pass; phase validator passed | passed | 2 | none |
| phase:3 | activation | test_result | yes | policy 22/22, activation 11/11, consumer/hook/MCP integration pass; phase validator passed | passed | 2 | none |
| phase:4 | control plane | test_result | yes | control-plane conformance 21/21 passes, including untrusted key ID and durable replay | passed | 2 | none |
| phase:5 | product proof | test_result | yes | Real User Proof v2 focused suite 12/12 passes; legacy v1 cannot claim readiness | passed | 1 | collect real users only under the separate verification program |
| phase:6 | integration | test_result | yes | focused suites pass; hook smoke 138/138; verify-hooks 88/88; integration 20/20; clean aggregate rerun passes; standalone public contract package passes; `git diff --check` passes; phase validator and holistic arbiter accept | passed | 3 | validator contention sample was resolved by an idle rerun; arbiter blocks on first-use consent identity and private contract packaging were repaired and accepted on re-judgment |
| phase:7 | use cases | test_result | yes | 5/5 realistic scenarios and 50/50 steps pass; durable privacy-safe proof emitted; full aggregate and `git diff --check` pass; independent phase validator passed | passed | 2 | first validator aggregate used an insufficient four-minute wrapper; corrected idle rerun passed in 370.6 seconds, and the canonical architecture location in `REPORT.md` was confirmed |

## Feature Ledger

- 2026-07-30: Five research reports and unified specification completed.
- 2026-07-30: Feature-mode architecture frozen with additive kernels and shared
  integrations deferred.
- 2026-07-30: Pre-existing security-assurance/shared-file changes inventoried.
- 2026-07-30: Aggregate baseline produced no failure output within 180 seconds,
  then timed out; recorded as unknown/inconclusive, never passed.
- 2026-07-30: Governance v1 and config/profile/bundle kernels passed focused
  tests; independent validation passed the kernels and held broad activation
  integration open.
- 2026-07-30: Governance Port alpha passed 21 conformance checks, including
  durable restart/replay, pinned signing, unknown trust, privacy, and tamper.
- 2026-07-30: Real User Proof v2 passed 12 focused tests; the superseded v1
  cohort is now instrument-only and cannot set `milestone_ready`.
- 2026-07-30: Governed adoption passed local plan/apply/doctor/leave plus
  update/rollback/restore/import, runtime projection, private-ledger, and exact
  legacy-boundary proofs; the public package CLI no longer exposes legacy
  update/rollback mutation paths.
- 2026-07-30: Progressive activation passed across setup, routing, direct
  prompts, hooks, health, circuit breaker, dashboard, MCP, and bundle-aware
  scaffolding. Standard defaults to Core + Persistence.
- 2026-07-30: Product integration passed skill lint (50 clean), hook smoke
  (138/138), installed-hook verification (88/88), hook integration (20/20),
  the complete aggregate, package dry-run, and `git diff --check`. The first
  independent aggregate recorded a dashboard update-budget miss while package
  checks were concurrent; the unchanged idle rerun passed and the phase
  validator advanced the phase.
- 2026-07-30: Holistic arbitration initially blocked first-use consent creating
  legacy semantics and the private/non-standalone public contract package.
  Consent now creates exact v2 Standard/Core+Persistence authority and rolls
  back on failure. `@citadel/contracts` now packs independently with 46 files,
  contains no root-core dependency, and has generated parity plus external-load
  tests. The same arbiter re-ran the full floor and returned `ACCEPT`.
- 2026-07-30: Real-use proof passed 5/5 scenarios and 50/50 executable user
  steps across fail-honest governance and Fleet, progressive activation,
  governed adoption and exit, the Governance Port plus standalone public
  contracts package, and privacy-safe Real User Proof v2 instrumentation. The
  durable record is source-bound and digest-only. Registry publication,
  independently owned external-repository conformance, human cohorts,
  retention, and comparative utility remain explicitly unproven.
- 2026-07-30: Independent Phase 7 validation passed after a clean 370.6-second
  aggregate run. The first four-minute validator timeout remains recorded as
  unknown rather than being promoted to pass.
- 2026-07-30: Final holistic arbitration re-ran all 50 real-use steps, re-derived
  the proof's source binding and privacy boundaries, passed `git diff --check`,
  and completed the full aggregate in 361.3 seconds. Binding verdict: `ACCEPT`.

## Decision Log

- Preserve Operations Protocol `0.1`, App Contract `1`, and Supervisor API `1`.
- Use independent config/profile/governance/adoption/control-plane/product-proof
  version axes.
- Use product **bundles**, not another overloaded capability namespace.
- Evidence truth is invariant; profiles vary only the next control disposition.
- Use receipt ownership for all mutation and leave decisions.
- Keep the external adapter `0.1` until independently owned conformance exists.
- Keep fixture, pilot, controlled, retention, and exit evidence denominators
  separate.
- Do not create Git-stash checkpoints in this dirty shared worktree: they would
  temporarily remove unrelated user work. Preserve changes in place and use
  narrow diffs plus append-only campaign evidence.
- Override legacy Archon timeout-as-pass prose for this campaign: timeout,
  malformed output, or missing evidence is `unknown`, never phase completion.

## Active Context

- Current phase: complete - final holistic verification accepted
- Completed implementation slices:
  - governed adoption and runtime projections
  - effective config and progressive activation
  - fail-honest governance authority and Fleet merge authorization
  - Governance Port alpha and strict NDJSON stdio transport
  - local-only Real User Proof v2 instrumentation
- Root ownership: campaign, architecture, shared integration, CLI, docs/skills,
  aggregate tests, final verification.
- Blocking issues: none.
- Baseline caveat: full aggregate duration exceeds the initial 180-second
  observation window.

## Continuation State

- checkpoint-phase-1: none (preserving unrelated dirty work in place)
- next: none; keep external publication, independent-repository conformance, and
  human outcome evidence as separate future programs

---HANDOFF---
- Research, architecture, implementation, integration, and real-use proof are complete
- Dirty user work remains in place; shared-file ownership stayed with root
- Fail-honest evidence overrides timeout-as-pass behavior across orchestration
- Phase 7 passed 5/5 scenarios, independent validation, full aggregate, and binding arbitration
---

## Completion Record

- Completed At: 2026-10-08T21:10:49.580Z
- Outcome: archived-completion
