---
title: "Load Citadel agents under GitHub Copilot CLI"
status: briefed
priority: normal
target: com.github.copilot/
---

## Description

Split out of `copilot-adapter-batched-tool-calls.md` (2026-10-11).

Citadel's agents (`agents/*.md`) are not loaded under Copilot CLI. With the Agent Plugins v1
`$schema` declared in `plugin.json`, Copilot reads agents only from `com.github.copilot/agents`
and warned that `agents/` at the plugin root is no longer read. The `$schema` declaration was
dropped to clear the loader warnings, which leaves agent loading under Copilot unresolved.

The agent files are written for Claude Code: frontmatter sets `model: opus`, `effort`,
`maxTurns`, `codex_max_chars` and Claude tool names. Copying them unchanged into
`com.github.copilot/agents` would likely give agents with unknown models and tools.

## Acceptance Criteria

- Decide whether Copilot should load Citadel agents at all, and which ones.
- If yes: generate `com.github.copilot/agents/` from `agents/` with frontmatter mapped to
  Copilot's agent format (model names, tool names), with a `--check` drift guard like
  `scripts/generate-copilot-plugin.js`, and re-add the Agent Plugins v1 `$schema` together with
  an `mcp.json` (the root `.mcp.json` currently declares no servers).
- Verified against a live Copilot CLI (e.g. the AgentSandbox `github-copilot-citadel` profile):
  agents are listed and no loader warnings remain.
- Update the `$schema` assertion in `scripts/test-copilot-runtime.js` to match.

## Brief (2026-10-12)

**Scope:** Medium. About half is already done in the uncommitted `gh-copilot` working tree.

**Already in progress (uncommitted):**
- Decision made in practice: all seven agents are generated into `com.github.copilot/agents/*.agent.md`.
- `scripts/generate-runtime-agents.js` with a `--check` drift guard, plus `runtimes/copilot/generators/agents.js`,
  `runtimes/*/agent-settings.json` and `core/agents/runtime-settings.js` for model-tier mapping.

**Remaining:**
1. Re-add the Agent Plugins v1 `$schema` to `plugin.json` together with an `mcp.json` that declares the
   Citadel MCP servers (the root `.mcp.json` declares none).
2. Flip the assertion in `scripts/test-copilot-runtime.js:374` (it currently requires `$schema` to be absent).
3. Wire `generate-runtime-agents.js --check` into `scripts/test-all.js` if it isn't already.
4. Live check: agents listed under Copilot CLI with no loader warnings.

**Files:** `plugin.json`, a new `mcp.json`, `scripts/test-copilot-runtime.js`, `scripts/test-all.js`.

**Quality gates:** `node scripts/generate-runtime-agents.js --check`, `node scripts/test-copilot-runtime.js`,
`node scripts/test-all.js --strict` pass; a live Copilot CLI lists the agents with no loader warnings.

**Risks:**
- Declaring `$schema` changes where Copilot reads MCP servers. Without `mcp.json`, Citadel's MCP tools vanish.
- Steps 1-3 touch files with uncommitted edits, so finish them inside the current `gh-copilot` work rather than separately.
- The live check depends on AgentSandbox Copilot support, which is deferred. Hold the item's completion until it lands.
