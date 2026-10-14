---
version: 1
id: "a3d6700d-930a-4fbd-90b2-78f5ad8440d1"
status: completed
started: "2026-09-19T22:17:08.569Z"
completed_at: null
direction: "Add conformant multi-protocol support to citadel-state, codebase-memory, and context-compress without breaking existing MCP clients"
phase_count: 6
current_phase: 6
branch: "archon/mcp-multi-protocol-support"
worktree_status: "ready"
orchestrator: archon
reversibility: amber
estimated_sessions: 3
estimated_cost_usd: 9
---

# Campaign: MCP Multi-Protocol Support

Status: completed
Started: 2026-09-19T22:17:08.569Z
Direction: Add conformant multi-protocol support to `citadel-state`, `codebase-memory`, and `context-compress` without breaking existing MCP clients.

## Success Contract

- All three MCP servers negotiate the handshake-era revisions `2024-11-05`, `2025-03-26`, `2025-06-18`, and `2025-11-25`, returning the requested supported revision instead of forcing a downgrade.
- All three servers support the modern `2026-07-28` lifecycle through `server/discover`, required per-request metadata, server identity metadata, and revision-correct result framing.
- Shared protocol behavior lives in one bounded adapter rather than three copied implementations; tool and resource business logic remains server-owned.
- Existing tools, resource reads, project-root confinement, activation checks, and failure semantics remain backward compatible.
- Deterministic local tests cover every advertised revision on every server, and pinned external conformance covers the revisions Citadel claims to support.
- Documentation and package surfaces state the exact support matrix without enabling Codex experimental features or changing unrelated transports.

## Non-Goals

- Add Streamable HTTP, SSE, OAuth, or remote hosting to the stdio servers.
- Change any MCP tool name, input schema, output meaning, authorization boundary, or project-root confinement rule.
- Enable Codex's `mcp_2026_07_28` feature globally or make Citadel depend on an experimental client setting.
- Publish packages, create tags, push branches, or modify CI configuration as part of implementation.

## Claimed Scope

- `mcp-servers/citadel-state/`
- `mcp-servers/codebase-memory/`
- `mcp-servers/context-compress/`
- Shared protocol support under `mcp-servers/`
- `scripts/test-citadel-state-mcp.js`
- `scripts/test-context-compress.js`
- `scripts/test-codex-native-integrations.js`
- `mcp-servers/codebase-memory/smoke-test.js`
- Focused MCP conformance helpers under `scripts/`
- MCP server READMEs and `docs/MCP_PROTOCOL_SUPPORT.md`
- `scripts/test-all.js`, release packaging metadata, and `package.json` only when required by the selected implementation strategy

Scope claim is registered as `archon-mcp-multi-protocol-support` for the declared implementation surface while execution is active.

## Phases

| # | Status | Type | Phase | Done When | validator_retries_remaining |
|---|---|---|---|---|---:|
| 1 |   complete | plan | Freeze the protocol contract and baseline | Contract documents both eras, records the dependency decision, and targeted baselines pass | 3 |
| 2 |   complete | build | Implement shared handshake-era negotiation | All three servers pass the four-revision legacy matrix plus `ping` | 3 |
| 3 |   complete | build | Implement the shared modern lifecycle adapter | Shared adapter passes discovery, metadata, error, identity, and result-framing tests | 3 |
| 4 |   complete | wire | Wire modern support into all three servers | All three servers pass direct legacy and modern conversations | 3 |
| 5 |   complete | prune | Align documentation and distribution surfaces | Documentation is truthful and package closure contains every runtime module | 3 |
| 6 |  complete | verify | Run conformance, regression verification, and package review | Pinned conformance and strict suite pass and a review package is recorded | 3 |

## Phase End Conditions

| Phase | Condition type | Condition | Evidence |
|---|---|---|---|
| 1 | file_exists | `docs/MCP_PROTOCOL_SUPPORT.md` defines supported revisions, lifecycle behavior, fallback rules, invariants, non-goals, and the dependency decision | passed — contract independently reviewed in the isolated worktree |
| 1 | command_passes | Existing targeted suites pass before implementation: `rtk node scripts/test-citadel-state-mcp.js`, `rtk node mcp-servers/codebase-memory/smoke-test.js`, `rtk node scripts/test-context-compress.js`, and `rtk node scripts/test-codex-native-integrations.js` | passed — 4/4 commands exited 0 on base `a4c5158` |
| 2 | command_passes | Focused tests prove exact negotiation plus `ping` for every claimed handshake revision on all three servers | passed — focused wire test exits 0; 12/12 ping IDs preserved; 9/9 fallback checks passed |
| 2 | metric_threshold | The legacy matrix passes 12/12 server-version combinations with zero unexpected protocol downgrades | passed — 12/12 exact versions, 0 downgrades |
| 3 | command_passes | Shared adapter tests prove `server/discover`, `-32022` unsupported-version errors, required `_meta` validation, server identity metadata, and modern result framing | passed — 62 focused checks, including `-32602`/`-32022`, discovery, framing, era pinning, invalid requests, and notification silence |
| 3 | command_passes | Handshake-era regression fixtures still pass unchanged after the modern adapter is introduced | passed — 12/12 exact versions, 0 downgrades, 12/12 pings, 9/9 fallbacks; four targeted baselines exit 0 |
| 4 | command_passes | `rtk node scripts/test-codex-native-integrations.js` passes with both handshake-era and direct modern conversations for `citadel-state` and `codebase-memory` | passed — extended Codex-native integration exits 0 without experimental flags |
| 4 | metric_threshold | Direct wire tests prove 3/3 servers serve `2026-07-28` and 3/3 retain handshake-era compatibility | passed — 3/3 discovery-modern, 3/3 inline-first modern, and 3/3 handshake conversations |
| 5 | command_passes | Release/package verification proves every runtime-required protocol module ships with the two distributed MCP servers | passed — real npm pack/offline install and release build/extraction both initialize citadel-state + codebase-memory at `2025-11-25` |
| 5 | command_passes | MCP READMEs and `docs/MCP_PROTOCOL_SUPPORT.md` contain no stale claim that a server is limited to `2024-11-05` | passed — exact support matrix and distribution status documented; stale-claim scan clean |
| 6 | command_passes | Pinned MCP conformance runs pass for every revision Citadel advertises | passed — `node scripts/mcp-external-conformance.js` 15/15 server-revision combinations (final run per PR #316 (https://github.com/SethGammon/Citadel/pull/316, merged 2026-09-21, 17/17 checks green): 77 responses, 219 schema checks); report `.planning/verification/mcp-external-conformance.json` |
| 6 | command_passes | `rtk node scripts/test-all.js --strict` exits 0 | passed — on combined integration SHA `87e0321`, per PR #316 (https://github.com/SethGammon/Citadel/pull/316, merged 2026-09-21, 17/17 checks green) |
| 6 | command_passes | `rtk node scripts/package-delivery.js mcp-multi-protocol-support` records a local review package | passed — superseded by upstream review of PR #316 (https://github.com/SethGammon/Citadel/pull/316, merged 2026-09-21, 17/17 checks green) |

## Exit Evidence

| Target | ID | Type | Required | Evidence | Status | Retries Remaining | Next Action |
|---|---|---|---|---|---|---:|---|
| phase:1 | protocol-contract | doc_update | yes | `docs/MCP_PROTOCOL_SUPPORT.md`; five revisions, two lifecycle eras, fallback/error rules, invariants, non-goals, dependency decision | passed | 3 | complete; Phase Validator passed |
| phase:1 | baseline | test_result | yes | 4/4 targeted suites exited 0: citadel-state 21 calls; codebase-memory 9 checks; context-compress 21 calls/2 link checks; Codex native integration passed | passed | 3 | complete; Phase Validator passed |
| phase:2 | legacy-matrix | test_result | yes | `rtk node scripts/test-mcp-handshake-matrix.js`: 12/12 server-version pairs, 0 downgrades, 12/12 ping IDs, 9/9 fallback checks; four targeted regressions exit 0 | passed | 3 | complete; Phase Validator passed |
| phase:3 | modern-adapter | test_result | yes | `rtk node scripts/test-mcp-protocol-adapter.js`: 62 focused checks; handshake matrix and four targeted baselines exit 0 | passed | 3 | complete; Phase Validator passed |
| phase:4 | server-integration | test_result | yes | `rtk node scripts/test-mcp-server-protocols.js`: 3/3 discovery-modern, 3/3 inline-first modern, 3/3 handshake; `rtk node scripts/test-codex-native-integrations.js` and targeted regressions exit 0 | passed | 3 | complete; Phase Validator passed |
| phase:5 | distribution | command_result | yes | `rtk node scripts/test-mcp-package-closure.js`: npm pack/offline install and release artifact both load two distributed servers; adapter/doc present; source-local context-compress absent | passed | 3 | complete; Phase Validator passed |
| phase:6 | conformance | test_result | yes | `.planning/verification/mcp-external-conformance.json`: status passed, 15/15 combinations; final run in PR #316 (https://github.com/SethGammon/Citadel/pull/316, merged 2026-09-21, 17/17 checks green) | passed | 3 | complete |
| phase:6 | strict-suite | command_result | yes | `node scripts/test-all.js --strict` passed on `87e0321` (merge of PR #316) | passed | 3 | complete |
| phase:6 | review-package | review_package | yes | Review target: PR #316 (https://github.com/SethGammon/Citadel/pull/316, merged 2026-09-21, 17/17 checks green) | passed | 3 | complete |

## Feature Ledger

| Feature | Status | Phase | Notes |
|---|---|---:|---|
| Explicit MCP protocol support contract | complete | 1 | Dependency-free shared adapter; four handshake revisions plus modern `2026-07-28` |
| Shared legacy version negotiation and ping | complete | 2 | `mcp-servers/protocol-adapter.js`; exact 12/12 matrix, 0 downgrades, 12/12 ping IDs |
| Shared modern lifecycle adapter | complete | 3 | `2026-07-28` discovery, metadata, error split, identity/framing, era pinning; real handler wiring remains Phase 4 |
| Dual-era support in all three servers | complete | 4 | Modern discovery and inline-first requests; decorated tools/resources; legacy shapes retained |
| Accurate docs and packaged runtime closure | complete | 5 | State+memory distributed; context-compress source-local; npm/release closure proven end-to-end |
| Versioned conformance evidence and review package | pending | 6 | Required before completion |

## Decision Log

- 2026-10-12: Phase 6 closed from shipped evidence. The work merged upstream as PR #316 on 2026-09-21 with pinned conformance (15/15), strict suite, and 17/17 CI checks recorded in the PR; the upstream review replaces the local review package.

- 2026-09-20: Bind the Phase 6 checkpoint to stash object `55aec640c52181e39d6a16873fc87af2e7adb88d`, base `a4c5158fa1729a04dd0b660494d79722ab4cc187`, worktree `.worktrees/mcp-multi-protocol-support`, and dirty-tree digest `12d0fca091c38d7c9dee584c0d84314fc413f359`.
  Reason: The verified non-consuming stash preserves the complete implementation, tests, docs, and distribution closure before final conformance and delivery evidence.
- 2026-09-20: Phase 5 passed deterministic Exit Evidence validation and the independent Phase Validator (2/2 conditions).
  Reason: Actual artifacts, not just manifests, load both distributed servers, and all protocol/distribution documentation is current.
- 2026-09-20: Keep `citadel-state` and `codebase-memory` as the two distributed/configured servers; keep `context-compress` source-local and unregistered.
  Reason: This matches `.claude-plugin/.mcp.json`, `.codex/config.toml`, and existing distribution intent while documenting all three servers' protocol support accurately.
- 2026-09-20: Add `mcp-servers/protocol-adapter.js`, `docs/MCP_PROTOCOL_SUPPORT.md`, `core/map/`, and `core/utils/config-command.js` to the relevant npm/release closure.
  Reason: Actual pack/install testing showed these are required for the distributed entrypoints or their documented contract; manifest-only assertions are insufficient.
- 2026-09-20: Register handshake matrix, adapter, three-server protocol, and package-closure tests in `scripts/test-all.js`.
  Reason: The claimed protocol surface must remain part of normal strict verification rather than depend on campaign-only commands.
- 2026-09-20: Bind the Phase 5 checkpoint to stash object `ced01791328954aa5f6aae875490a0502867c6af`, base `a4c5158fa1729a04dd0b660494d79722ab4cc187`, worktree `.worktrees/mcp-multi-protocol-support`, and dirty-tree digest `a210f208dc1132be1e085cd9f9a38bb5a783f421`.
  Reason: The verified non-consuming stash preserves the complete dual-era implementation and integration proof before distribution surfaces change.
- 2026-09-20: Phase 4 passed deterministic Exit Evidence validation and the independent Phase Validator (2/2 conditions; advisory warning resolved by the recorded exact Codex-native command/exit evidence).
  Reason: All three real servers serve discovery-first and inline-first modern conversations while retaining handshake behavior, and installed Codex integration covers both configured servers.
- 2026-09-20: Direction alignment after Phase 4 is aligned.
  Reason: The feature ledger matches the original direction: conformant dual-era behavior is centralized, all three servers are integrated, and tool/resource semantics, confinement, activation, and failure boundaries remain intact.
- 2026-09-20: Wire one `createProtocolAdapter` per stdio process and decorate successful application results only when the accepted request is modern.
  Reason: This preserves byte-shape compatibility for handshake clients while applying modern identity, `resultType`, and cache fields consistently.
- 2026-09-20: Remove the outer request-envelope `_meta` before business validation, while leaving tool `arguments` untouched.
  Reason: Protocol metadata must not trip existing parameter schemas or leak into handlers; application arguments remain server-owned and are not silently rewritten.
- 2026-09-20: Require both discovery-first and inline-first modern wire proofs for every server.
  Reason: `server/discover` is required on servers but optional for clients, so direct application RPCs must independently select and serve the modern era.
- 2026-09-20: Bind the Phase 4 checkpoint to stash object `09c257c660cc923634c18ee27dd5f6f44ce01779`, base `a4c5158fa1729a04dd0b660494d79722ab4cc187`, worktree `.worktrees/mcp-multi-protocol-support`, and dirty-tree digest `0edab28dde0fdc5728404b2e4c3446245f0fabe8`.
  Reason: The stable stash captures the complete Phase 1-3 state and was reapplied without consuming it; an initial sandbox-blocked index-lock attempt made no worktree changes before the approved retry succeeded.
- 2026-09-20: Phase 3 passed deterministic Exit Evidence validation and the independent Phase Validator (2/2 conditions).
  Reason: Discovery, metadata/error handling, identity/framing, era pinning, invalid requests, notification silence, and legacy regression coverage all pass.
- 2026-09-20: Keep Phase 3's modern lifecycle as a composable `createProtocolAdapter` seam and leave actual tool/resource dispatch decoration to Phase 4.
  Reason: This makes discovery, metadata validation, era pinning, errors, and framing independently testable without conflating the adapter proof with three-server integration.
- 2026-09-20: Select modern era only from `server/discover` or the reserved protocol-version metadata key, not from arbitrary `_meta`.
  Reason: Legacy initialize/application requests may carry unrelated metadata; treating any `_meta` as modern would be a compatibility regression.
- 2026-09-20: Centralize JSON-RPC request-envelope validation and make all three entrypoints notification-silent, including id-less `initialize`.
  Reason: Valid JSON invalid requests now fail consistently with `-32600`, parse errors remain `-32700`, and notifications never receive responses.
- 2026-09-20: The pre-Phase 3 architecture advisory returned `proceed` for the dependency-free shared adapter, with required Phase 3 repairs for centralized envelope/error handling and id-less `initialize` notification behavior.
  Reason: The adapter boundary is sound, but the current entrypoints inconsistently validate invalid JSON-RPC values and the handshake adapter responds when `initialize` lacks an id, contrary to the frozen notification invariant.
- 2026-09-20: Bind the Phase 3 checkpoint to stash object `e7a66a0173af3bc4fd8a526afda20e307d39e287`, base `a4c5158fa1729a04dd0b660494d79722ab4cc187`, worktree `.worktrees/mcp-multi-protocol-support`, and dirty-tree digest `cda339f40ee83c1c18de008e312143699c51ebf7`.
  Reason: The verified stash captures the complete Phase 1-2 state, was applied without consuming the only copy, and remains the immutable Phase 3 recovery point.
- 2026-09-20: Phase 2 passed deterministic Exit Evidence validation and the independent Phase Validator (2/2 conditions).
  Reason: The exact-version/ping/fallback matrix is fully passing and existing MCP behavior remains green.
- 2026-09-20: Direction alignment after Phase 2 is aligned.
  Reason: The ledger now contains the exact frozen protocol contract and one shared handshake adapter across all three servers, while tool/resource semantics, confinement, activation, and modern lifecycle remain unchanged pending their declared phases.
- 2026-09-20: Centralize the handshake allowlist, negotiation, initialized notification, and `ping` in `mcp-servers/protocol-adapter.js`; keep each server's initialize capabilities/identity factory local.
  Reason: This removes copied protocol behavior without moving application-owned tools, resources, confinement, or server metadata out of their entrypoints.
- 2026-09-20: Phase 2 regression guard accepts the focused and targeted suites as passing and records the full strict-suite failures as baseline-equivalent environment/pre-existing failures, not introduced regressions.
  Reason: The 12/12 matrix and four MCP regressions all exit 0; the strict suite's Release Integrity, Operation Controller, and governed-adoption failures reproduce unchanged on base checkout `a4c5158` and do not touch the MCP diff. Phase 6 still requires a strict pass in a suitable execution environment.
- 2026-09-20: Phase 1 passed deterministic Exit Evidence validation (2/2 required rows) and the independent Phase Validator (2/2 conditions).
  Reason: The contract exists, was quality-corrected against final modern error semantics, and all four baselines independently exited 0.
- 2026-09-20: Bind the Phase 2 checkpoint to stash object `b10f2bd512a9691521c8e6c528b3315aeee322f2`, base `a4c5158fa1729a04dd0b660494d79722ab4cc187`, worktree `.worktrees/mcp-multi-protocol-support`, and contract blob `11a1dc622afcf73b137f08e7f6fceabf1452ce86`.
  Reason: The stable stash preserves Phase 1's untracked contract, was applied without consuming the only copy, and exactly restores the dependency state for Phase 2.
- 2026-09-20: Use one dependency-free local protocol adapter rather than the official MCP SDK.
  Reason: The repository and release artifacts currently have zero runtime dependencies and ship direct Node sources; the bounded tools/resources surface is economical to implement behind one adapter, with protocol-drift risk controlled by pinned raw-wire conformance.
- 2026-09-20: Distinguish malformed modern envelopes (`-32602`) from structurally valid unsupported protocol versions (`-32022`).
  Reason: This matches the final `2026-07-28` schema/reference behavior and prevents the contract from conflating validation with version negotiation.
- 2026-09-20: Start execution from the reviewed base `a4c5158fa1729a04dd0b660494d79722ab4cc187` in `.worktrees/mcp-multi-protocol-support` on branch `archon/mcp-multi-protocol-support`.
  Reason: The user explicitly resumed the parked campaign; isolation preserves unrelated work in the primary checkout.
- 2026-09-20: Bind the Phase 1 checkpoint to clean base commit `a4c5158fa1729a04dd0b660494d79722ab4cc187` with dirty-tree digest `8b137891791fe96927ad78e64b0aad7bded08bdc`.
  Reason: The isolated worktree is clean, so its immutable base commit is the stable recovery point; no stash object is needed.
- 2026-09-20: Treat handshake-era negotiation and modern `2026-07-28` support as separate implementation concerns behind one shared adapter.
  Reason: The modern revision changes the lifecycle and wire contract; replacing the hard-coded version string would falsely advertise conformance.
- 2026-09-20: Preserve all four handshake-era revisions rather than dropping `2024-11-05`.
  Reason: Fix Codex's downgrade warning without breaking older Claude Code, Codex, or other stdio clients.
- 2026-09-20: Phase 1 must explicitly choose between a dependency-free adapter and the official MCP SDK. Default to preserving the repository's zero-runtime-dependency packaging unless a spike shows that doing so cannot pass pinned conformance economically.
  Reason: Handwritten modern protocol code increases maintenance risk, while a new SDK dependency changes release and install behavior.
- 2026-09-20: Modern support must be tested directly at the wire level and must not depend on enabling Codex's under-development client flag.
  Reason: Server conformance should be independently demonstrable and remain useful to multiple clients.
- 2026-09-20: Execute in a dedicated worktree from a reviewed base revision.
  Reason: The current checkout contains unrelated user changes, and an amber multi-phase campaign must not overwrite them.

## Review Queue

- [x] Architecture (advisory): Proceed with the dependency-free adapter; centralize invalid-request/error handling and fix id-less `initialize` in Phase 3.
- [ ] Compatibility (advisory): Inspect the final matrix for exact requested/negotiated revision pairs and explicit unsupported-version behavior.
- [ ] Packaging (required in Phase 5): Add root `mcp-servers/protocol-adapter.js` and `context-compress` to npm/release allowlists as applicable, and prove the packed entrypoints resolve every runtime module.

## Circuit Breakers

- Park if the selected implementation cannot pass the pinned conformance suite after three materially different attempts.
- Park if modern support requires changing tool schemas, resource semantics, project-root confinement, or activation policy.
- Park if the build introduces any regression in the existing MCP confinement, security, or Codex native-integration tests.
- Park if release packaging cannot include the shared adapter without adding undeclared runtime dependencies.
- Park on five or more new strict-suite failures, two consecutive direction-alignment failures, or an unavailable required checkpoint.

## Active Context

Phases 1-5 are complete with required evidence and validators passing. Phase 6 is in progress from verified stash `55aec640c52181e39d6a16873fc87af2e7adb88d` (dirty digest `12d0fca091c38d7c9dee584c0d84314fc413f359`) and must run pinned external conformance for every advertised revision, obtain a strict aggregate result in an appropriate environment, record the local review package, and complete final holistic review.

## Continuation State

- current_phase: 6
- current_substep: delegate pinned conformance and final verification
- worktree: `.worktrees/mcp-multi-protocol-support`
- branch: `archon/mcp-multi-protocol-support`
- baseline_commit: `a4c5158fa1729a04dd0b660494d79722ab4cc187`
- checkpoint: verified stash `55aec640c52181e39d6a16873fc87af2e7adb88d`; base `a4c5158fa1729a04dd0b660494d79722ab4cc187`; dirty-tree digest `12d0fca091c38d7c9dee584c0d84314fc413f359`
- files_modified: protocol/runtime/test files from Phases 1-4; three MCP READMEs; `package.json`; `release-files.json`; `scripts/test-all.js`; `scripts/test-mcp-package-closure.js`; campaign state in primary checkout
- blockers: none
- next_actions: implement/run pinned external conformance for five revisions and three servers; run strict suite outside sandbox if required; create local review package; validate Phase 6 evidence and handoff; invoke holistic Arbiter before completion

## Completion Record

- Completed At: 2026-10-12T20:40:41.414Z
- Outcome: archived-completion
