# Citadel on opencode — Installation Guide

Citadel runs on opencode as a third runtime alongside Claude Code and Codex.
opencode has no command hooks, so Citadel ships an **in-process plugin** that
spawns the existing `hooks_src/*.js` Node processes and translates their exit
codes into opencode's throw/mutate semantics. Every hook is reused unchanged.

Verified live against **opencode 1.18.30 / Bun 1.4.2 / Node 24.12.0 on Windows 11**
(2026-09-10). See `docs/OPENCODE_SUPPORT_PLAN.md` section 5 for the evidence log.

## Requirements

| | |
|---|---|
| opencode | 1.18.x (`bun add -g opencode-ai`) |
| Node | 18+ **on `PATH`** — the hooks are Node scripts, and under Bun `process.execPath` is the Bun binary, so the plugin resolves Node via `which`/`where node` |
| Bun | whatever opencode ships with |
| Citadel | a local checkout; the plugin stub points at it by absolute path |

## Install

```bash
# 1. preview — writes nothing
node /path/to/Citadel/scripts/opencode-install.js --project-root /path/to/project --dry-run

# 2. install
node /path/to/Citadel/scripts/opencode-install.js --project-root /path/to/project

# 3. verify
node /path/to/Citadel/scripts/opencode-readiness-check.js --project-root /path/to/project
#    exits 0 when the required checks pass; add --strict to also fail on advisory gaps
```

`scripts/install.js --runtime opencode` dispatches to the same installer.

### What it writes

| Path | Purpose |
|---|---|
| `.opencode/plugin/citadel.js` | Stub re-exporting the adapter from your Citadel checkout, so a Citadel upgrade takes effect without reinstalling |
| `opencode.json` | Merged key by key: adds `$schema` and `mcp.citadel-state`. User keys are preserved |
| `.opencode/agent/*.md` | Seven Citadel subagents |

Re-running the installer is a no-op and preserves hand-edited keys (verified: a
hand-added `provider` block survived a second install untouched).

### Read natively, not projected

- **Guidance** — `AGENTS.md`, then `CLAUDE.md`.
- **Skills** — `.claude/skills/**/SKILL.md`, `.agents/skills/**`, `.opencode/skill/**`.
- **Commands** — opencode registers every discovered skill as a command
  (`source: "skill"`). Do **not** write `.opencode/command/*.md` for a skill: an
  explicit command file *shadows* the live skill.

### Readiness check output

A healthy install:

```
PASS  plugin stub present
PASS  opencode.json parses
PASS  citadel-state MCP registered
PASS  agents projected — 7 in .opencode/agent
PASS  node binary resolved for hooks — C:\nvm4w\nodejs\node.exe
PASS  pre-tool gate blocks a .env read
```

Confirm the resolved Node path is a **real Node**, not Bun. Override with
`CITADEL_NODE=/path/to/node` if the probe picks the wrong one.

`guidance file present` and `skills discoverable by opencode` fail on a bare
project — neither is written by this installer. See *Skills* below.

## Confirming the plugin actually loaded

**A plugin that fails to load is silent.** opencode publishes a plugin error and
then runs normally **with no Citadel gating at all**. An absence of errors in the
TUI is not evidence. Read the log:

```bash
opencode --print-logs --log-level DEBUG
```

Look for Citadel's own line, written through opencode's logger at startup:

```
level=INFO message="citadel session start" messages="[\"[citadel] hooks ok (24 recent events), gates active, ...\"]"
```

If that line is absent, the plugin did not load and you are unprotected.

The fastest positive check is the readiness script's live gate probe, which
refuses a `.env` read through the real hook.

## Verifying the gate end to end

Ask opencode to read a `.env`. Expect the tool call to come back as an **error**
whose text is the hook's own message, with the session continuing normally:

```
TOOL read  status=error
  error: [protect-files] Blocked: cannot read .env — .env files contain secrets.
```

## Known limits

These are upstream properties of opencode, not Citadel bugs.

### `session.idle` cannot block

opencode dispatches bus events fire-and-forget (`void hook["event"]?.(...)`), so
`quality-gate` is **observational** on this runtime — it records findings but
cannot force continuation. Contract: `stop-cannot-block`.

### `permission.ask` never fires

Declared in the plugin SDK but never triggered (upstream anomalyco/opencode
[#7006](https://github.com/anomalyco/opencode/issues/7006),
[#9229](https://github.com/anomalyco/opencode/issues/9229)). Gating rides
`tool.execute.before`, where blocking is real and tested. Do not build on
`permission.ask`. Contract: `permission-gate-not-native`.

### Plugin load failure fails open

If the module cannot load, opencode continues with no Citadel hooks. The load
path is kept minimal to reduce the chance. Contract:
`plugin-load-failure-fails-open`.

### The `!` shell bypasses the gate

`POST /session/{id}/shell` — the TUI's `!command` — does **not** fire
`tool.execute.before`. A command run this way is not gated: a force-push issued
through it completes ungated, and a probe plugin on `tool.execute.before`
records nothing.

This does not weaken gating of **agent** actions, which is what Citadel gates:
model-issued `bash` calls go through the tool wrapper and are gated normally.
But a human typing `!` at the TUI is outside Citadel's reach on this runtime.

### Adding a plugin needs a server restart

Plugin discovery happens once per opencode **process**. Disposing and recreating
the project instance re-runs each loaded plugin's init but does **not** rescan
`.opencode/plugin/`. After installing Citadel into a project, restart opencode.

## Skills are not projected — a real gap

opencode reads `.claude/skills/**/SKILL.md`, and Citadel's installer projects
**nothing** there. Citadel's 48 skills live in `Citadel/skills/`, and in Claude
Code they arrive through the plugin marketplace, which opencode has no
equivalent of. **The result is that no Citadel skill is available in opencode out
of the box.**

The mechanism itself works — a skill copied into the project's `.claude/skills/`
is discovered and registered as a command with `source: "skill"`. Only the
projection step is missing. Until it exists, make skills available yourself:

```bash
# per project
cp -r /path/to/Citadel/skills/* /path/to/project/.claude/skills/

# or globally, for every opencode project
cp -r /path/to/Citadel/skills/* ~/.config/opencode/skill/
```

opencode warns `duplicate skill name` when the same skill is found in several
roots; it keeps the first and ignores the rest.

## Guidance is not projected either

The same gap applies to `AGENTS.md`. `runtimes/opencode/guidance/render.js`
exists and exports a working `OPENCODE_GUIDANCE_TARGET`, but
`opencode-install.js` never invokes it — it lists guidance as "no projection".
Rendering it also needs a `.citadel/project.md` project spec, which the opencode
install path does not create (`.citadel/` gets only `plugin-root.txt`,
`scripts/` and `version.txt`).

So `AGENTS.md` is yours to author. opencode reads `AGENTS.md` first, then
`CLAUDE.md`, so an existing `CLAUDE.md` already works with no extra step.

A fresh, correct install reports both `guidance file present` and
`skills discoverable by opencode` as **WARN**, with a remedy line, and still
exits 0. The readiness check separates two severities: *required* covers what the
installer guarantees plus the live proof that the gate blocks, and only those set
the exit code; *advisory* covers capability a project gains by supplying
something Citadel does not project. Pass `--strict` to make the advisory gaps
exit non-zero too, which is what you want in CI.

Earlier builds marked all eight checks alike, so a correct install failed its own
verification and exited 1.

## Performance

Each gated tool call spawns one Node process per matching hook. Measured on
Windows (Bun 1.4.2, Node 24):

| Tool | Hooks spawned | Latency |
|---|---|---|
| `glob`, `grep`, `webfetch` | 0 | ~0 ms |
| `read` | 1 (`protect-files`) | ~50 ms |
| `bash` | 2 (`external-action-gate`, `governance`) | ~99 ms |
| `edit` / `write` | 2 (`protect-files`, `governance`) | ~100 ms |

Plugin init (the session-start chain) is ~214 ms warm; the first run in a new
project takes several seconds because it also scaffolds `.planning/` and
`.citadel/`.

Trimming `CITADEL_BUNDLES` does **not** reduce this: every pre-tool hook is in
the core security bundle, so `CORE_BUNDLE` selects exactly the same set. If the
latency ever bites, a persistent hook worker is the fix, not bundle trimming.

## Telemetry

Hooks write to the **project's** `.planning/telemetry/`, not the Citadel
checkout — verified: entries carry the project's own name and no path resolves
back to Citadel.

```
.planning/telemetry/audit.jsonl         tool-call events, canonical tool names
.planning/telemetry/hook-errors.jsonl   blocks, e.g. {"hook":"protect-files","action":"blocked"}
.planning/telemetry/hook-timing.jsonl   per-hook durations
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| No gating, no errors | Plugin did not load. Check the log for `citadel session start` |
| Citadel line absent after installing | opencode was already running — restart it |
| `node binary resolved` shows a Bun path | Node is not on `PATH`; set `CITADEL_NODE` |
| No Citadel slash commands | Skills are not projected — see *Skills* above |
| `!command` not gated | Expected; the shell endpoint bypasses `tool.execute.before` |
| `quality-gate` never blocks | Expected; `session.idle` cannot block |
