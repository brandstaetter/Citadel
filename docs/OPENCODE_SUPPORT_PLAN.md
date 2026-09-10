# opencode Runtime Support — Investigation and Plan

Date: 2026-09-10
Status: phases 1-6 landed; 1-5 live-verified on opencode 1.18.30 / Bun 1.4.2, all three phase-5 follow-ups closed, phase 6 delivered by deferred injection (re-prompt deliberately declined)

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
| Guidance | `AGENTS.md`, then `CLAUDE.md` (`session/instruction.ts:61-68`) | **its own renderer.** This row first said "reuse Codex's `AGENTS.md` renderer"; both target `AGENTS.md`, but the Codex output calls itself the Codex projection and tells the reader to invoke skills as `$skill-name`, which is wrong for opencode. Rendered from `.citadel/project.md`, never overwriting an existing file |
| Skills | also every path in `skills.paths`, scanned `**/SKILL.md` (`skill/index.ts:211-219`) | **one config key.** This row first claimed "none — opencode reads Citadel's existing `.claude/skills/` projection directly", which phase 5 disproved: no such projection exists. Resolved by adding `<citadel>/skills` to `skills.paths` in `opencode.json`, so all 48 are discovered from the checkout with nothing copied. Needs opencode >= 1.18.30 |
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

**Phase 5 — live verification and docs. DONE.** Run against **opencode 1.18.30,
Bun 1.4.2, Node 24.12.0, Windows 11** on 2026-09-10, in a scratch project
installed with `scripts/opencode-install.js`. The plan was written against
`anomalyco/opencode@dev` as of 2026-09-10; 1.18.30 is the released build closest
to it.

Method note: opencode's headless server (`opencode serve --print-logs
--log-level DEBUG`) plus its HTTP API was used instead of the TUI, because it
makes every claim observable — the log shows plugin load, `/agent`, `/skill` and
`/command` enumerate what the `@` and `/` menus render, and `/session/{id}/
prompt_async` drives a real turn. No Anthropic credentials were available, so a
local Ollama model (`qwen3.5:9b`, registered through a `provider` block in the
project's `opencode.json`) supplied the model-driven items. That is sufficient:
every item here is about opencode's plumbing, not about model quality.

| # | Claim | Result |
|---|---|---|
| 1 | The plugin loads at all | **PASS** |
| 2 | `resolveNodeBinary()` falls through to `which node` | **PASS** |
| 3 | A thrown block reaches the model | **PASS** |
| 4 | In-place `args` mutation is honored | **PASS** (both halves) |
| 5 | Spawn latency is tolerable | **PASS**, ~50 ms per hook |
| 6 | Agents render in the `@` menu | **PASS** |
| 7 | Skills appear as commands | **MECHANISM PASSES, OUTCOME FAILS** |
| 8 | Telemetry lands | **PASS** |

The three blocking items (1-3) all pass, so the runtime contract's
`hooks: partial` claim stands and needs no narrowing. Two new degradations were
found and are recorded below.

**1 — plugin loads.** Positive evidence, not absence of errors. The plugin logs
through opencode's own logger at init:

```
level=INFO message="citadel session start" messages="[\"[citadel] hooks ok (24 recent events), gates active, last verify: none\"]"
```

`createRequire` reaching the CommonJS runner works under Bun. Corroborated by
side effect: a bare scratch project gained `.planning/`, `.citadel/` and
`.claude/` at 17:31:38.5, filling the 9.6-second gap between config load
(17:31:29.2) and `init` (17:31:38.9) — the `init-project` session-start hook
running inside opencode's bootstrap.

**2 — Node resolution.** `opencode-readiness-check.js` reports
`node binary resolved for hooks — C:\nvm4w\nodejs\node.exe`. A real Node, not
the Bun binary. The `basename === 'node'` branch never fires under Bun as
predicted, and the `where`/`which` probe is what runs.

**3 — a thrown block reaches the model.** A real turn, prompted to read `.env`:

```
TOOL read  status=error
  input : {"filePath":"...\\oc-project\\.env"}
  error : "[protect-files] Blocked: cannot read .env — .env files contain secrets."
ASSISTANT: The `.env` file was blocked from being read by the security system...
```

The exit-2 to `throw` translation lands as a tool **error**, carries the hook's
own stderr, the model reads it, and the session continues rather than dying.
This also confirms the `filePath` to `file_path` canonicalization end to end.
The block is recorded in `.planning/telemetry/hook-errors.jsonl` as
`{"hook":"protect-files","action":"blocked","detail":"Read .env (.env secrets)"}`.

**4 — in-place mutation, both halves.** Citadel's own adapter never rewrites
args — `runHooksForEvent` blocks or appends messages, and the phase-3 test
asserts only that the live reference survives. So this was verified with a
standalone probe plugin on `tool.execute.before`, driving real model-issued
`bash` calls:

- `output.args.command = "echo MUTATION_HONORED_INPLACE"` — the tool ran the
  rewritten command. **Honored.**
- `output.args = { command: "echo MUTATION_HONORED_REPLACE" }` — the tool ran
  the *original* `echo PROBE_REPLACE`. **Silently discarded.**

The aliasing in `normalizeOpencodeHookInput` is load-bearing exactly as
documented. Do not "clean it up".

**5 — spawn latency, measured.** One Node process per matching hook, timed
against the real plugin under Bun:

| Tool | Hooks | Latency |
|---|---|---|
| `glob`, `grep`, `webfetch` | 0 | ~0 ms |
| `read` | 1 (`protect-files`) | mean 51 ms |
| `bash` | 2 (`external-action-gate`, `governance`) | mean 99 ms |
| `edit`/`write` | 2 (`protect-files`, `governance`) | ~100 ms |

Plugin init is 214 ms warm. Tools with no matching matcher cost nothing, which
keeps the common read-only path free.

*Correction to this item's suggested remedy.* The plan proposed comparing
against a session with `CITADEL_BUNDLES` trimmed. That does nothing: every
pre-tool hook is in `CORE_BUNDLE`, so a core-only selection picks exactly the
same hooks for `Read`, `Bash`, `Edit` and `Write`. Bundle trimming is not a
latency lever at pre-tool. A persistent hook worker is the only real follow-up.

**6 — agents render.** `GET /agent` returns 14: opencode's five built-ins
(`build`, `plan`, `compaction`, `summary`, `title`), its `explore` and `general`,
and exactly the seven Citadel agents projected into `.opencode/agent`. All carry
short readable descriptions. The `parse-agent.js` fix from phase 4 is confirmed
live: arbiter's description is **611 characters**, matching the phase-4 note
exactly, with no `"# model"` junk keys.

**7 — skills. The mechanism works; the outcome does not.** This is the
phase's contradiction, and the reason the item is not a plain PASS.

`GET /skill` in the installed project returned 13 skills, and **not one was
Citadel's**: twelve came from the user's global `~/.claude/skills`, one
(`customize-opencode`) is an opencode built-in. The project had no
`.claude/skills` directory at all.

Section 1's table says skills need "none — opencode reads Citadel's existing
`.claude/skills/` projection directly". **There is no such projection.**
Citadel's 48 skills live in `Citadel/skills/`, and under Claude Code they reach
a session through the plugin marketplace, which opencode has no equivalent of.
Nothing in `opencode-install.js` writes them, and the Citadel repo itself has no
`.claude/skills`. The consequence: a correct install yields zero Citadel skills
and therefore zero Citadel slash commands.

The reading of `command/index.ts` was right — copying one skill
(`skills/architect`) into the project's `.claude/skills/` made opencode expose it
both as a skill and as a command with `source: "skill"`, unshadowed, with the
body as the template. Only the projection step was missing. Phase 4 was right to
drop `project-commands.js`; what it needed instead was a *skills* projector.

*Resolved after phase 5, and not by copying.* opencode's config has a
`skills.paths` array, scanned `**/SKILL.md` (`skill/index.ts:211-219`), so the
installer adds `<citadel>/skills` to it and all 48 skills are discovered straight
from the checkout. No copies, so a Citadel upgrade needs no reinstall and nothing
can go stale — the same approach the plugin stub already took. The array is
user-owned, so Citadel appends and dedupes rather than replacing; `--skip-skills`
omits the key entirely.

This needs opencode >= 1.18.30. The top-level config is a plain `Schema.Struct`,
so on a build predating `skills.paths` the key would fail the decode and opencode
would refuse to start. `core/v1/config/skills.ts` was checked at tag v1.18.30 —
the build this phase ran against — *before* relying on the key, because the MCP
`args` mistake in phase 4 was exactly this failure mode found too late.

One consequence worth knowing: `skills.paths` is scanned **last**, after global
and project `.claude`/`.agents` and the `.opencode` dirs, and `add()` overwrites
on a name collision. So the Citadel entry wins over a project-local copy of the
same skill. (This also corrects the note above: on a duplicate, the *later* scan
wins, not the first.) To customize a skill, point `skills.paths` at your own
directory rather than editing a copy that will be overridden.

**8 — telemetry lands.** `.planning/telemetry/` in the **project** fills with
`audit.jsonl`, `hook-timing.jsonl`, `hook-errors.jsonl`, `session-costs.jsonl`.
Entries carry `"project":"oc-project"` and canonical tool names (`Bash`, not
`bash`); no path resolves back to the Citadel checkout.

**Which opencode events actually fire.** The plan asked for this to be recorded
rather than fixed. Observed from `hook-timing.jsonl` over the session, every
mapped event fired:

| opencode | Citadel hook | Seen |
|---|---|---|
| plugin init | session-start chain | yes |
| `tool.execute.before` | `protect-files`, `external-action-gate`, `governance` | yes |
| `tool.execute.after` | observers | yes |
| `chat.message` | `user-prompt-submit` | yes (x4) |
| `session.idle` | `quality-gate` | yes (x10), observational |
| `config` | `config-change` | yes (x5) |
| `dispose` | `session-end` | yes (x3) |

`intake-scanner` also ran (x6). Nothing in the map failed to fire.

**Two new degradations, neither in the plan.**

*The `!` shell bypasses the gate.* `POST /session/{id}/shell` — the TUI's
`!command` — does **not** fire `tool.execute.before`. `git push --force origin
main` issued through it ran ungated (it failed only on git's own refspec error),
and a probe plugin on `tool.execute.before` recorded nothing for those calls.
Section 2.2 lists four call sites and concludes "coverage of tool calls is
complete"; the shell endpoint is a fifth path that does not go through the tool
wrapper. This does not weaken gating of *agent* actions — model-issued `bash`
goes through the wrapper and is gated, verified in item 4 — but a human typing
`!` is outside Citadel's reach on this runtime. Worth a `degradations` entry.

*Plugin discovery is per process, not per instance.* Dropping a new plugin into
`.opencode/plugin/` and recreating the project instance via `/instance/dispose`
re-runs each **already-loaded** plugin's init but does not rescan the directory
— the new plugin never loaded, and, exactly as trap 1 warns, said nothing. Only
a full opencode restart picked it up. Installing Citadel into a project while
opencode is running therefore leaves the session ungated with no error. The
installation guide says to restart.

**Guidance had the same gap as skills, and the readiness check could not pass.**
`runtimes/opencode/guidance/render.js` exported a working
`OPENCODE_GUIDANCE_TARGET`, but `opencode-install.js` never invoked it — section 1
and the installer both filed guidance under "no projection". Rendering it also
needed a `.citadel/project.md` spec the opencode install path did not create.

*Resolved after phase 5.* A new `generators/project-guidance.js` renders
`AGENTS.md`, reusing `ensureProjectSpec` from the shared bootstrap so the spec is
created the same way on every runtime. It writes only `AGENTS.md` — unlike
`bootstrap-project-guidance.js`, which also writes `CLAUDE.md`; an opencode
install has no business creating that.

Two things the "unreachable code" framing missed. First, the renderer was not
merely dead, it was **wrong**: a re-export of the Codex renderer, whose output
announces itself as "the Codex-facing projection", carries a "## Codex Notes"
section, and instructs the reader to use `$skill-name` — while phase 5 verified
opencode registers skills as `/` commands. Wiring it in unchanged would have
handed opencode users a misleading file, so it was rewritten rather than simply
called. Second, an existing `AGENTS.md` must not be touched: it is opencode's
primary guidance file and is often hand-written, so the generator skips it unless
`--overwrite-guidance` is passed, and a test asserts the existing bytes survive.

With this, a default install passes all eight readiness checks — `READY.` with no
advisory gaps — and `--strict` passes too. `--skip-guidance` and `--skip-skills`
each produce a WARN that `--strict` refuses.

The consequence is worth stating plainly: `opencode-readiness-check.js` asserted
`guidance file present` and `skills discoverable by opencode`, and the installer
deliberately produces neither, so **a fresh correct install failed its own
readiness check and the script exited 1**.

*Resolved after phase 5.* The check now carries two severities. **Required**
covers what `opencode-install.js` guarantees it wrote — the plugin stub, a
parseable `opencode.json`, the `citadel-state` MCP entry, a resolved Node binary —
plus the live proof that the pre-tool gate blocks a `.env` read; only these set
the exit code. **Advisory** covers capability a project gains by supplying
something Citadel does not project: guidance, skills, and agents (the last
because `--skip-agents` is a supported choice). Advisory failures render as WARN
with a remedy line and still exit 0; `--strict` makes them fatal for CI.

Downgrading is not hiding: both gaps are still reported on every run, each with
what to do about it, and a test asserts they appear as WARN with a remedy.
Restoring either to required, downgrading a required check, ignoring `--strict`,
or dropping the remedy text each fail the suite.

The root cause was a test fixture, not the check. `scratchProject()` in
`scripts/test-opencode-install.js` hand-created `AGENTS.md` and
`.claude/skills/do/SKILL.md` and then asserted the readiness check passed — it
encoded the assumption instead of testing it, and hid the gap for a whole phase.
The fixture is now deliberately bare, with a separate `furnishedProject()` for
the case where every advisory check should also pass.

*Exit met:* `docs/OPENCODE_INSTALLATION_GUIDE.md` written from these
observations. Items 1-3 pass, so `hooks: partial` stands unchanged;
`shell-endpoint-not-gated` and `plugin-discovery-requires-restart` were added to
the runtime contract's `degradations`, which was the only code change this phase
made. The skills gap (7), the guidance gap, and the readiness-check contradiction
were the three follow-ups this phase surfaced; **all three are now closed** — see
the resolution notes above. A default install passes all eight readiness checks.
The runtime contract itself was unchanged by those fixes beyond the two
degradations this phase added.

**Phase 6 — Stop recovery. DONE, by deferred injection only.**

opencode dispatches bus events fire-and-forget, so by the time `quality-gate` has
a verdict the turn is over and nothing can be refused. Before this phase the
verdict was *discarded*. Now it is persisted and delivered on the next turn.

A prerequisite bug surfaced while wiring it. Citadel hooks answer on stdout with a
JSON envelope, not plain text — `{hookSpecificOutput: {additionalContext}}` for a
non-blocking finding, `{decision: 'block', reason}` for a blocking one,
`{hook, action, message}` for the UI shape. The adapter was taking
`firstLine(stdout)`, so the *raw JSON envelope* was what reached the model. The
findings were already arriving, just unreadably. `messageFromStdout` now unwraps
all three shapes, and an envelope it does not recognize is dropped rather than
shown raw.

`plugin/pending-notices.js` holds the store at
`.planning/opencode/pending-notices.json`. Notices are deduped by content, because
`session.idle` fired ten times in the phase-5 session and the verdict is usually
identical — without dedupe the model would see ten copies. They are capped at 20,
newest kept, so a long session cannot build an unbounded prompt injection, and
each notice is truncated at 4000 characters. A corrupt store reads as empty rather
than throwing: losing a deferred notice is bad, breaking the session is worse.
Draining happens after the caller has the contents, so a render failure cannot
lose them.

*Re-prompt via `ctx.client` was deliberately not implemented.* The plan said
"validate first", and this environment has neither Bun nor opencode nor model
credentials, so it cannot be validated here. It would drive real model turns and
spend tokens autonomously, and the loop guard — cap per session, never re-prompt a
re-prompt — is both the dangerous part and exactly what cannot be tested without a
live session. Shipping an unvalidated autonomous re-prompt loop would be worse
than not shipping it. The stated exit condition does not require it.

The runtime contract is unchanged: `stop-cannot-block` still holds, because a
finding delivered on the next turn is delivery, not enforcement. Claiming
otherwise would be the kind of over-statement this document exists to prevent.

*Exit met:* `scripts/test-opencode-adapter.js` drives the real `quality-gate` hook
against a fixture with a genuine violation, confirms the finding is human text
rather than a JSON blob, fires `session.idle` twice and asserts one notice is
recorded, then asserts the finding is pushed onto the next `chat.message`'s
existing parts array and not repeated on the turn after. Seven mutations were each
confirmed to fail: showing the envelope raw, removing the dedupe, removing the
cap, a drain that does not clear, a corrupt store that throws, not persisting idle
findings, and replacing `output.parts` instead of pushing.

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
