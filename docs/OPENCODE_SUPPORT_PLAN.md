# opencode Runtime Support — Investigation and Plan

Date: 2026-09-10
Status: proposal (no implementation in this change)

Verified against the opencode source at `anomalyco/opencode@dev` (shallow clone,
2026-09-10), specifically `packages/plugin/src/index.ts`,
`packages/opencode/src/plugin/index.ts`, `packages/opencode/src/session/tools.ts`,
`packages/opencode/src/session/prompt.ts`, `packages/opencode/src/skill/index.ts`,
`packages/opencode/src/session/instruction.ts`, `packages/opencode/src/config/`,
and `packages/web/src/content/docs/plugins.mdx` (the published
https://opencode.ai/docs/plugins/ page).

## 1. Verdict

Yes. opencode is a better fit for Citadel than Codex was, with one structural
difference that drives the whole design: **opencode has no command hooks.**
Claude Code and Codex both run `node hooks_src/<hook>.js`, feed it JSON on
stdin, and read exit code 2 as "block". opencode has **in-process plugins** —
async JS/TS functions loaded into the agent process (Bun) that mutate a shared
`output` object and `throw` to block.

So the adapter sits one layer lower than `hooks_src/codex-adapter.js`. Instead
of translating a hook *config map* into a runtime's hook config, we ship an
actual opencode plugin that **spawns the existing `hooks_src/*.js` processes**
and translates their exit codes and stderr back into opencode's
throw/mutate semantics. Every one of the 30+ existing hooks is reused
unchanged; no hook logic is rewritten.

Non-hook surfaces are close to free:

| Surface | opencode native path | Citadel work |
|---|---|---|
| Guidance | `AGENTS.md`, then `CLAUDE.md` (`session/instruction.ts:61-68`) | none — reuse Codex's `AGENTS.md` renderer |
| Skills | `.claude/skills/**/SKILL.md`, `.agents/skills/**/SKILL.md`, `.opencode/{skill,skills}/**/SKILL.md` (`skill/index.ts:21-24,187-207`) | none — opencode reads Citadel's existing `.claude/skills/` projection directly |
| Agents | `.opencode/{agent,agents}/**/*.md` (`config/agent.ts:13`) | thin projector, mirror `runtimes/codex/generators/project-agents.js` |
| Commands | `.opencode/{command,commands}/**/*.md` | thin projector |
| MCP | `opencode.json` `mcp` block | config emit for `citadel-state`, `codebase-memory` |
| Plugin install | `.opencode/{plugin,plugins}/*.{ts,js}` auto-discovered, or `plugin: []` in `opencode.json` (`config/config.ts:476`, `config/plugin.ts:21`) | emit one file |

## 2. The hook mechanism, precisely

### 2.1 Contract

`packages/plugin/src/index.ts` — every lifecycle hook is
`(input, output) => Promise<void>`. `packages/opencode/src/plugin/index.ts`
dispatches them:

```ts
for (const hook of s.hooks) {
  const fn = hook[name] as any
  if (!fn) continue
  yield* Effect.promise(async () => fn(input, output))
}
return output
```

Three consequences that shape the adapter:

1. **Hooks are sequential and awaited.** Ordering is deterministic; a slow hook
   stalls the turn. opencode applies **no timeout**. The adapter must enforce
   the per-hook timeouts already declared in `hooks/hooks-template.json`.
2. **Blocking is `throw`.** `Effect.promise` turns a rejection into a defect.
   Confirmed scoped, not fatal, by opencode's own test
   (`test/tool/code-mode.test.ts:429`): *"a failing before hook fails only that
   child call as a catchable in-program error"*. The thrown message reaches the
   model as the tool result. This is exactly Citadel's exit-2 + stderr contract.
3. **Mutation is in place, on the same object.** `session/tools.ts:104-112`:

   ```ts
   const ctx = context(args, options)
   yield* plugin.trigger("tool.execute.before", { tool: item.id, ... }, { args })
   const result = yield* item.execute(args, ctx)
   ```

   `item.execute` receives the original `args`, not `output.args`. **Mutating
   `output.args.command` works; reassigning `output.args = {...}` is silently
   discarded.** Same pattern for `chat.message`: `prompt.ts:999` passes
   `resolvedParts` and then iterates that same array, so *pushing* a part
   injects context, *replacing* `output.parts` does not. This is a sharp edge
   worth a comment in the adapter and a regression test.

### 2.2 Event mapping

`tool.execute.before` fires from four call sites — the generic tool wrapper
(`session/tools.ts:107`), MCP resource tools (`:176`, `:259`, `:339`, `:403`),
the `task` subagent path (`session/prompt.ts:308`), and code-mode
(`tool/code-mode.ts:142`) — so coverage of tool calls is complete. It runs
**before** the tool's own `ctx.ask()` permission prompt, which makes it a
stronger gate than Claude Code's `PermissionRequest`.

| Citadel event | opencode | Support | Note |
|---|---|---|---|
| `pre_tool` | `tool.execute.before` | full | throw = block; in-place arg mutation |
| `post_tool` | `tool.execute.after` | full | can rewrite `output.output`/`title`/`metadata` |
| `user_prompt_submit` | `chat.message` | partial | push onto `output.parts` to inject; no block |
| `session_start` | plugin init function | full | runs once per project directory per server instance |
| `session_end` | `dispose()` | partial | instance teardown, not per-session |
| `pre_compact` | `experimental.session.compacting` | partial | experimental; can append context or replace prompt |
| `post_compact` | `session.compacted` event | partial | observe-only |
| `stop` | `session.idle` event | **degraded** | observe-only; see 2.4 |
| `config_change` | `config` hook | full | receives full resolved config |
| `file_changed` | `file.edited`, `file.watcher.updated` events | full | observe-only |
| `permission_request` | `permission.asked` event | **degraded** | see 2.3 |
| `permission_denied` | `permission.replied` event | partial | observe-only |
| `task_created` / `task_completed` | `session.created`, `task` tool hooks | partial | |
| `post_tool_batch`, `post_tool_failure`, `stop_failure`, `user_prompt_expansion`, `instructions_loaded`, `cwd_changed`, `elicitation*`, `teammate_idle`, `worktree_*` | — | none | no equivalent; skip with a recorded warning, same as the Codex installer does |

### 2.3 `permission.ask` is a trap

The SDK declares
`"permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" })`.
It is **never triggered** — `grep -rn '"permission.ask"' packages/opencode/src`
returns nothing outside the type definition. Upstream issues
[#7006](https://github.com/anomalyco/opencode/issues/7006) and
[#9229](https://github.com/anomalyco/opencode/issues/9229) (closed as
duplicate) confirm the active permission module only publishes `permission.asked`
bus events. **Do not build the security gate on this hook.** Citadel's
`protect-files` and `external-action-gate` must ride `tool.execute.before`,
where blocking is real and tested. `permission-request.js` degrades to
observe-only on the `event` hook.

### 2.4 `stop` cannot block

`plugin/index.ts` dispatches bus events fire-and-forget:

```ts
for (const hook of hooks) {
  void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
}
```

`void` — not awaited, rejections swallowed. So `session.idle` is pure
observation and `quality-gate` loses its ability to force continuation. Two
recoveries, in order of preference:

1. **Deferred injection (phase 2).** Persist gate findings and push them onto
   `output.parts` in the next `chat.message`. Same information, one turn late,
   zero new machinery.
2. **Re-prompt (phase 3, validate first).** The SDK exposes
   `POST /session/{id}/prompt_async`, `/tui/append-prompt`, `/tui/submit-prompt`
   (`packages/sdk/openapi.json`). On `session.idle` with a failing gate, the
   plugin can re-prompt via `ctx.client`. This restores Stop-blocking behavior
   but needs a loop guard (cap re-prompts per session, never re-prompt a
   re-prompt) before it goes anywhere near a default.

Either way the capability contract must say `hooks: partial` with
`stop-cannot-block` in `degradations`. Claiming parity here would be false.

### 2.5 Tool and argument naming

opencode tool ids are lowercase and its file argument is `filePath`, not
`file_path`. Confirmed ids: `read`, `write`, `edit`, `bash`
(`tool/shell/id.ts:16`), `glob`, `grep`, `task`, `apply_patch`, `skill`,
`webfetch`, `websearch`, `todowrite`, `question`, `plan_exit`, `execute`
(code-mode). `apply_patch` is only registered for GPT-family models
(`tool/registry.ts:297-300`), so the Codex adapter's patch-splitting logic is
needed here too, but conditionally.

`core/hooks/normalize-event.js` already has a `TOOL_MAP` and
`normalizePathFields`. Both need extending, and `createEnvelope` needs to stop
choosing the map with `runtime === 'codex' ? CODEX : CLAUDE` and switch on the
runtime id properly.

## 3. Architecture

```
opencode process (Bun)
  └─ .opencode/plugin/citadel.js                 ← new, generated
       └─ runtimes/opencode/plugin/index.mjs     ← new, the adapter
            ├─ normalizeOpencodeHookInput()      ← new, reuses core/hooks/normalize-event
            └─ spawn node hooks_src/<hook>.js    ← unchanged, 30+ existing hooks
                 exit 2 + stderr  →  throw new Error(stderr)
                 exit 0 + stdout  →  mutate output in place
```

The plugin is ESM (Bun), the hooks are CommonJS Node scripts. Bun supports
`node:child_process`, so the boundary is an `execFile` with `input`, a timeout
from the template, and `CLAUDE_PROJECT_DIR` in the env — the same contract
`hooks_src/codex-adapter.js` already implements, minus the exit-code plumbing
and plus promise-based timeouts so the agent's event loop is never blocked
synchronously.

Reusing `hooks_src/*.js` as subprocesses, rather than porting them into the
plugin, is the whole point: one security implementation, one telemetry writer,
one set of tests. The cost is process spawn latency per tool call (~30-60ms for
Node startup). `pre_tool` fires on every tool call, so this is the main
performance risk and the reason for 6.3 below.

## 4. Files

New:

```
runtimes/opencode/runtime.js                      capability contract
runtimes/opencode/index.js                        barrel, mirrors runtimes/codex/index.js
runtimes/opencode/adapters/hook-input.js          envelope normalization
runtimes/opencode/plugin/index.mjs                the adapter plugin
runtimes/opencode/plugin/citadel-plugin.js        generated stub for .opencode/plugin/
runtimes/opencode/generators/install-plugin.js    writes the stub + opencode.json
runtimes/opencode/generators/project-agents.js    .opencode/agent/*.md
runtimes/opencode/generators/project-commands.js  .opencode/command/*.md
runtimes/opencode/guidance/render.js              re-export of the AGENTS.md renderer
scripts/opencode-install.js                       install entry, mirrors codex-install.js
scripts/opencode-readiness-check.js               verification
scripts/test-opencode-adapter.js                  adapter unit tests
docs/OPENCODE_INSTALLATION_GUIDE.md
```

Modified:

```
core/contracts/runtime.js          add 'opencode' to RUNTIME_IDS + adapter matrix
core/runtime/registry.js           register the runtime
core/runtime/detect-runtime.js     .opencode marker + process-tree, checked BEFORE codex
core/hooks/normalize-event.js      OPENCODE_EVENT_MAP, lowercase tools, filePath
scripts/install.js                 --runtime opencode
citadel-metadata.json              runtime_support.opencode
package.json                       files[], opencode:install, opencode:verify
scripts/test-runtime-registry.js   assertions
scripts/test-runtime-matrix.js     matrix row
docs/HOOKS.md, README.md, INSTALL.md
```

`packages/contracts/vendor/` is generated — run
`node scripts/generate-public-contracts.js` after touching `core/contracts/`.

## 5. Phases

Each phase is independently shippable and under the 35-minute execution
boundary from `CLAUDE.md`.

**Phase 1 — contract and detection.** Add `opencode` to `RUNTIME_IDS`, the
adapter matrix (`level: hook-enabled`, missing: Stop-blocking, permission
gating), `runtimes/opencode/runtime.js`, registry, detection. Regenerate
vendored contracts.
*Exit:* `node scripts/test-runtime-registry.js` and
`node scripts/test-all.js` pass; `CITADEL_RUNTIME=opencode` resolves.

**Phase 2 — event normalization.** `OPENCODE_EVENT_MAP`, lowercase tool ids,
`filePath` → `file_path`, `normalizeOpencodeHookInput`. Fixture-driven, no
opencode needed.
*Exit:* new fixtures under `scripts/fixtures/` normalize to the same envelopes
the Claude and Codex adapters produce for equivalent input.

**Phase 3 — the plugin adapter.** `runtimes/opencode/plugin/index.mjs` wiring
`tool.execute.before` (throw on exit 2), `tool.execute.after`, `chat.message`,
`event`, `config`, plugin-init as session start, `dispose` as session end.
Per-hook timeouts from `hooks-template.json`. `apply_patch` target splitting,
reusing the Codex parser.
*Exit:* `scripts/test-opencode-adapter.js` proves a `protect-files` block
throws with the hook's stderr as the message, a non-security hook failure does
not throw, an in-place `args` mutation survives, and a timeout is enforced.

**Phase 4 — install and projection.** `install-plugin.js` writing
`.opencode/plugin/citadel.js` and merging `opencode.json` (preserving
user keys, same merge discipline as `core/hooks/install.js`), agent and command
projectors, MCP config, `scripts/opencode-install.js`,
`scripts/opencode-readiness-check.js`.
*Exit:* `--dry-run` lists exact writes; `opencode:verify` passes on a scratch
project.

**Phase 5 — live verification and docs.** Run the harness against real
opencode: confirm `protect-files` blocks an `.env` read, `external-action-gate`
blocks a gated `bash`, `post-edit` fires, telemetry lands in `.planning/`.
Record skipped events. Then docs and the capability table.
*Exit:* `docs/OPENCODE_INSTALLATION_GUIDE.md` plus a recorded live-verify
artifact, as `scripts/codex-live-verify.js` does for Codex.

**Phase 6 (optional) — Stop recovery.** Deferred gate injection via
`chat.message`; re-prompt via `ctx.client` behind a config flag and a
re-prompt cap.
*Exit:* a failing quality gate demonstrably reaches the model on the next turn.

## 6. Risks

1. **Upstream API churn.** Six hooks are `experimental.*` and `permission.ask`
   is declared-but-dead. Depend only on `tool.execute.before/after`,
   `chat.message`, `event`, `config`, `dispose`; treat everything else as
   optional and feature-detect. Pin the `@opencode-ai/plugin` version in the
   generated config.
2. **Mutate-in-place vs reassign.** Silent no-op if an author reassigns
   `output.args`. Mitigation: a regression test per mutating hook, and a comment
   at each mutation site.
3. **Spawn latency on `pre_tool`.** ~30-60ms of Node startup per tool call.
   Mitigation: bundle-filter so only enabled hooks spawn; measure in phase 5;
   if it bites, a persistent hook worker is a follow-up, not a prerequisite.
4. **Bun/Node boundary.** The plugin runs in Bun, hooks in Node. Keep the
   plugin dependency-free and ESM-only; never `require()` Citadel CommonJS from
   plugin scope — cross the boundary only by spawning `process.execPath`
   equivalents, resolving the Node binary explicitly rather than assuming
   `process.execPath` is Node (under Bun it is `bun`).
5. **Detection collision.** `detect-runtime.js` tests `includes('codex')` then
   `includes('claude')`. "opencode" matches neither, but the opencode check must
   still come first, and `.opencode` must join the `.claude`/`.codex`
   marker-recency logic rather than bypassing it.
6. **Honest capability reporting.** `hooks: partial`, with
   `stop-cannot-block`, `permission-gate-not-native`, and
   `no-batch-or-failure-events` in `degradations`. Citadel's value here is
   accurate degradation reporting, not claimed parity.

## 7. Effort

| Phase | Estimate |
|---|---|
| 1 contract + detection | 0.5d |
| 2 normalization | 0.5d |
| 3 plugin adapter | 1.5d |
| 4 install + projection | 1d |
| 5 live verify + docs | 1d |
| 6 Stop recovery (optional) | 1d |

~4.5 days to a verified integration, ~5.5 with Stop recovery. Cheaper than the
Codex work because guidance and skills need no projection at all.
