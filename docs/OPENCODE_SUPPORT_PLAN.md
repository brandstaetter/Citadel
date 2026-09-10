# opencode Runtime Support — Investigation and Plan

Date: 2026-09-10
Status: phases 1-4 landed; phase 5 is a checklist awaiting a Bun/opencode environment; phase 6 optional

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
| Commands | `.opencode/{command,commands}/**/*.md` | none — opencode registers every discovered skill as a command (`command/index.ts:134`), and an explicit command file *shadows* the skill, so projecting would risk overriding the live one |
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
| `permission_denied` | `permission.replied` event | partial | observe-only, and **not** statically mapped: a reply may allow or deny, so only the adapter can tell whether it is a denial |
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
(no project-commands.js — opencode derives commands from skills, and an
 explicit command file shadows the live skill)
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

**Phase 1 — contract and detection. DONE.** Added `opencode` to `RUNTIME_IDS`,
the adapter matrix (`level: hook-enabled`, missing: Stop-blocking, permission
gating), `runtimes/opencode/runtime.js`, the registry, and detection. Vendored
contracts regenerated.

Implementation note the plan missed: runtime resolution is duplicated across
**three** sites, not one. `core/runtime/detect-runtime.js` (process tree +
marker recency) is what the plan described, but `core/config/runtime.js`
`detectRuntimeContract` is the one hooks, the dashboard, and the MCP server
actually call, and `scripts/citadel-config.js` carries a third copy of the
`runtimeContract` switch. All three now resolve `opencode`; without the second,
`CITADEL_RUNTIME=opencode` would have reported a capability-free unknown
runtime to every hook. The two marker scans deliberately keep different
tiebreaks — `detect-runtime.js` picks the most recently touched marker
directory, `config/runtime.js` stays unknown when several are present — so
both were generalized rather than merged.

`core/cli/package-cli.js` still normalizes only `claude` and `codex`, so
`citadel install --runtime opencode` fails with `RUNTIME_NOT_FOUND`. Left
deliberately: it is install plumbing with no installer behind it yet, and a
clean error beats a half-wired path. Phase 4 owns it, along with
`markerRuntimes` and the two runtime error messages that name only the two
runtimes.

*Exit met:* `test-runtime-registry.js`, `test-runtime-matrix.js`,
`test-runtime-contracts.js`, `test-config-consumers.js`,
`test-adoption-lifecycle.js`, `integration-test.js`, `test-cli-package.js`,
`test-backward-compat.js`, and `generate-public-contracts.js --check` all pass;
`CITADEL_RUNTIME=opencode` and a lone `.opencode` marker both resolve to the
opencode contract.

**Phase 2 — event normalization. DONE.** Added `OPENCODE_EVENT_MAP`, lowercase
tool ids, `filePath` → `file_path` canonicalization, and
`normalizeOpencodeHookInput`. `createEnvelope` now selects its event map from an
`EVENT_MAPS` registry instead of `runtime === 'codex' ? CODEX : CLAUDE`.

The adapter absorbs opencode's field names (`sessionID`, `callID`, `tool`,
`args`, `directory`, and the `{providerID, modelID}` model object) so phase 3
can pass `{ ...input, args: output.args }` straight through. It keeps `raw` as
the caller's own object rather than a copy, because the plugin has to mutate
opencode's argument object in place — the only mutation opencode honors.

`task` maps to `Agent`, so the governance hook's existing `Agent` matcher fires
on opencode subagent spawns. `apply_patch` is deliberately *not* in the tool
map: adapters split it into per-target Edit/Write projections, which needs the
native id to survive normalization.

Correction to the event table in 2.2: `permission_denied` ← `permission.replied`
was wrong. A reply may allow or deny, so a static mapping would mislabel
allowed actions as denials half the time. `permission.replied` is now
deliberately unmapped, and resolving a denial is the phase-3 adapter's job.
`session.error` is likewise unmapped — a session failure is not Claude Code's
`StopFailure`, which fires when the stop hook itself fails. The fixture records
every deliberate omission with its reason, and the test fails if any of them
silently acquires an event id.

*Exit met:* `scripts/fixtures/opencode-hook-events.json` drives a cross-runtime
equivalence test — each opencode payload and its Claude Code twin must reduce to
identical envelope fields — plus drift detection between the fixture's mapped
list and the shipped map. Beyond the stated exit, the real hooks were driven
with opencode-shaped payloads end to end: `protect-files` blocks a `read` of
`.env` and allows `README.md`; `external-action-gate` blocks
`git push --force origin main` (P-001) and `gh pr merge 1`, and allows a plain
`git push`, which is tier `allow` by default.

**Phase 3 — the plugin adapter.** `runtimes/opencode/plugin/index.mjs` wiring
`tool.execute.before` (throw on exit 2), `tool.execute.after`, `chat.message`,
`event`, `config`, plugin-init as session start, `dispose` as session end.
Per-hook timeouts from `hooks-template.json`. `apply_patch` target splitting,
reusing the Codex parser.
*Exit:* `scripts/test-opencode-adapter.js` proves a `protect-files` block
throws with the hook's stderr as the message, a non-security hook failure does
not throw, an in-place `args` mutation survives, and a timeout is enforced.

**Phase 3 — the plugin adapter. DONE.** Landed as two files rather than one:
`runtimes/opencode/plugin/hook-runner.js` (CommonJS) holds the logic, and
`runtimes/opencode/plugin/index.mjs` is the thin ESM module opencode loads. The
split is what makes the phase testable: the Citadel suite exercises the runner
and, via a require-cache stub, the shim's contract under plain Node, with no Bun
and no opencode install.

Two corrections to the plan:

*The plan said never to `require()` Citadel CommonJS from plugin scope.* That was
wrong, and following it would have meant duplicating the event map and the legacy
payload projection inside the plugin, which defeats phase 2's single
normalization and would drift. `createRequire` works under Bun, and the modules
needed (`normalize-event`, `hook-context`, `bundles`) are pure logic with no
native dependencies. The real constraint is narrower: do no work at import time,
and resolve a Node binary explicitly rather than trusting `process.execPath`,
which under Bun is the Bun binary.

*`apply_patch` needed a matcher alias, which the plan did not mention.* The
template's matchers are `Edit|Write`, `Read`, `Bash`, `Agent` — `apply_patch`
matches none of them, so selecting hooks by the native tool id gated it with
nothing at all. The alias is applied at match time (`apply_patch` also matches
`Edit` and `Write`), and each selected entry's matcher is re-checked against the
individual projected target so a `Write`-only matcher cannot fire on an `Edit`
projection.

Blocking is narrower than the plan implied. Only `tool.execute.before` can abort
a call, so that is the single member of `BLOCKING_OPENCODE_EVENTS`. Throwing from
`tool.execute.after` would report a tool that already succeeded as failed, so
post-tool findings are appended to the output text the model sees instead. Hooks
that fail on a non-blocking event never break the turn.

Security hooks (`protect-files`, `external-action-gate`) fail closed on a
blocking event: a missing implementation, a crash, a non-2 exit, a timeout, or an
unparseable `apply_patch` body all refuse the action. Observers never do. Because
opencode enforces no hook timeout of its own, the adapter enforces the per-hook
timeouts from `hooks-template.json` itself, with async spawn so a 30-second
`post-edit` cannot stall opencode's event loop.

Known fail-open, and not fixable from inside the plugin: if the module fails to
load, opencode publishes a plugin error and continues with no Citadel gating.
The load path is kept minimal to reduce the chance, and the runtime contract
already declares `plugin-adapter-required-for-hook-parity`.

*Exit met:* `scripts/test-opencode-adapter.js`, registered in `test-all.js`,
drives the real `hooks_src` processes — `protect-files` blocks a `.env` read and
allows `README.md`; `external-action-gate` blocks a force-push; an `apply_patch`
touching `.env` is blocked, as is an unparseable patch body; a missing or
timed-out security hook fails closed; `tool.execute.after` never blocks. Eight
deliberate mutations were each confirmed to fail the suite, including removing
the `apply_patch` alias, letting post-tool block, replacing `output.parts`
instead of pushing, and snapshotting `output.args` instead of passing the live
reference. `node scripts/test-all.js --strict` passes.

**Phase 4 — install and projection.** `install-plugin.js` writing
`.opencode/plugin/citadel.js` and merging `opencode.json` (preserving
user keys, same merge discipline as `core/hooks/install.js`), agent and command
projectors, MCP config, `scripts/opencode-install.js`,
`scripts/opencode-readiness-check.js`.
*Exit:* `--dry-run` lists exact writes; `opencode:verify` passes on a scratch
project.

**Phase 4 — install and projection. DONE.** `scripts/opencode-install.js` writes
`.opencode/plugin/citadel.js`, merges `opencode.json`, and projects agents into
`.opencode/agent`. `scripts/opencode-readiness-check.js` verifies a project and
ends with a live probe that the pre-tool gate actually refuses a `.env` read.
`--runtime opencode` now works through `scripts/install.js`, and
`core/cli/package-cli.js` recognizes the runtime, the `.opencode` marker, and
probes the right binary — closing the gap phase 1 left open.

Three corrections to the plan:

*`project-commands.js` must not exist.* `command/index.ts:134-151` registers
every discovered skill as a command (`source: "skill"`), and opencode already
reads `.claude/skills/**/SKILL.md`, so all Citadel skills become opencode
commands with no projection. Worse, the loop is `if (commands[item.name])
continue` — an explicit command file **shadows** the skill, so a projected copy
would go stale and silently override the live one. The generator was dropped and
a test asserts the file stays absent.

*The MCP config shape in the plan would have broken every install.* opencode's
`McpLocalConfig` (`core/v1/config/mcp.ts`) takes a single `command` argv array —
there is no `args` key — plus `environment` rather than `env`. It is a plain
`Schema.Struct`, so an unknown key fails the decode and opencode hard-fails at
startup. Asserted key by key in the tests.

*Command frontmatter is strict where agent frontmatter is not.* `ConfigCommandV1`
is a plain Struct and its loader throws `InvalidError` on an unknown key, while
`ConfigAgentV1` carries a Record rest that folds unknown keys into `options`.
Only agents are projected, so only the lenient surface is written — but the
distinction matters for phase 6.

The agent projector emits what opencode expects: the name comes from the
filename (not frontmatter), the body is the prompt, and `mode: subagent`.
`opencode.json` is merged key by key because it is user-owned and opencode
hard-fails on invalid content; an unparseable file is refused rather than
clobbered, and a second install is a no-op.

**A pre-existing parser bug was fixed beyond this phase's scope**, because the
projection put it in front of users: `core/agents/parse-agent.js` treated YAML
`#` comments as keys (producing frontmatter entries literally named `"# model"`)
and its folded-scalar regex swallowed trailing comments into `description`. The
arbiter's description was 1408 characters of mostly YAML comments, and opencode
shows `description` in its `@` autocomplete. Two precise fixes — skip comment
lines when parsing keys, and terminate a folded scalar at a column-0 `#` — cut it
to 611 characters and removed the junk keys. This also improves the existing
Codex projection, which shared the bug; `test-codex-runtime`,
`test-agent-projections`, and `test-codex-native-integrations` all still pass.

*Exit met:* `--dry-run` lists exact writes and provably creates nothing;
`opencode:verify` passes on a scratch project, including the live gate probe.
`scripts/test-opencode-install.js` is registered in `test-all.js`, and five
mutations were each confirmed to fail it — an `args`-key MCP config, a merge that
drops user MCP servers, a merge that replaces the whole config, clobbering an
unparseable `opencode.json`, and a dry run that writes anyway.

**Phase 5 — live verification and docs. NOT STARTED.** Needs Bun and opencode
actually installed, which the environment phases 1-4 were built in did not have.

Rewritten after phases 2-4, because the original plan for this phase listed
checks that phases 2-4 now cover under plain Node — re-running them locally
would prove nothing new. `scripts/test-opencode-adapter.js` already drives the
real `hooks_src` processes and asserts that `protect-files` blocks a `.env` read
and allows `README.md`, that `external-action-gate` blocks a force-push and
`gh pr merge`, that an `apply_patch` touching `.env` is blocked per target, and
that a missing or timed-out security hook fails closed.

What remains unverified is everything that only behaves differently *inside*
opencode. Each item below is a claim made from reading opencode's source, never
observed running:

| # | Claim to verify | Why it can only be checked under Bun | How to check |
|---|---|---|---|
| 1 | The plugin loads at all | `index.mjs` reaches the CommonJS runner through `createRequire`, which is untested under Bun. On failure opencode publishes a plugin error and continues **with no Citadel gating** — a silent fail-open | Start opencode in an installed project and read its log. Absence of errors in the TUI is not proof; look for the plugin error event |
| 2 | `resolveNodeBinary()` falls through to `which node` | Under Bun `process.execPath` is the Bun binary, so the `basename === 'node'` branch never fires and the `which`/`where` probe is what actually runs | `node scripts/opencode-readiness-check.js` reports the resolved path; confirm it is a real Node, not Bun |
| 3 | A thrown block reaches the model | The exit-2 → `throw` translation has never crossed into opencode's tool-result path | Ask opencode to read a `.env`; the `[protect-files] Blocked:` text should appear as the tool result, and the session must continue rather than dying |
| 4 | In-place `args` mutation is honored | Read out of `session/tools.ts:104-112`; the reassign-is-discarded behavior is inferred, not observed | Have a hook rewrite `output.args.command` and confirm the tool runs the rewritten command |
| 5 | Spawn latency is tolerable | ~30-60ms of Node startup per `pre_tool`, on every tool call. The one risk flagged in section 6 with no measurement | Time a session with several tool calls against the same session with `CITADEL_BUNDLES` trimmed; if it bites, a persistent hook worker is the follow-up |
| 6 | Agents render in the `@` menu | The frontmatter shape is built from `config/agent.ts` and `ConfigAgentV1`, and the descriptions depend on the `parse-agent.js` fix | Open the `@` autocomplete and confirm the seven Citadel agents appear with short, readable descriptions |
| 7 | Skills appear as commands | opencode is expected to register each `.claude/skills/**/SKILL.md` as a command (`command/index.ts:134`) with no projection | Confirm Citadel's skills are offered as slash commands, and that none is shadowed by a stale file |
| 8 | Telemetry lands | Hooks write Citadel state as usual, but nothing has confirmed the project root reaches them correctly under opencode | Check `.planning/` for telemetry after a session, and that paths resolve to the project, not the Citadel checkout |

Also worth recording rather than fixing: which opencode bus events fire in
practice, since the adapter's skip list is derived from the event map rather
than from observation.

*Exit:* `docs/OPENCODE_INSTALLATION_GUIDE.md` plus a recorded live-verify
artifact, as `scripts/codex-live-verify.js` does for Codex. Items 1-3 are the
blocking ones: if any fails, the runtime contract's `hooks: partial` claim is
too generous and must be narrowed before this ships.

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
