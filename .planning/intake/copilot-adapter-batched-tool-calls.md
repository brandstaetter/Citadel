---
title: "Copilot hook adapter: support batched toolCalls (apply_patch raw args)"
status: completed
priority: high
target: runtimes/copilot/adapters/hook-input.js
---

## Description

Found on 2026-10-11 while testing the AgentSandbox `github-copilot-citadel` profile (Citadel
1.4.3 local pack `242ce526…`, loaded with `copilot --plugin-dir`, GitHub Copilot CLI 1.0.95,
native login, Ubuntu 24.04 guest).

Copilot 1.0.95 sends `preToolUse` as a **batch**:

```json
{"sessionId":"…","cwd":"/home/agent/workspace",
 "toolCalls":[{"id":"…","name":"apply_patch",
   "args":"*** Begin Patch\n*** Add File: /home/agent/workspace/hello.txt\n+hello\n*** End Patch\n"}]}
```

`normalizeCopilotHookInput` (`runtimes/copilot/adapters/hook-input.js`) only understands the
single-tool shape (`toolName` / `toolArgs`). For the batched shape the envelope has no
`tool_name`, so `validateSecurityEnvelope` (`hooks_src/copilot-adapter.js:66`) throws
`protect-files requires apply_patch, Edit, Write, or Read`, and `protect-files` (a security hook)
fails closed with exit 2:

```
[copilot-adapter] protect-files input projection failed: protect-files requires apply_patch, Edit, Write, or Read
```

Result: every file write in a Copilot + Citadel session is denied ("Denied by preToolUse hook:
hook exited with code 2"). `governance` passes (non-security hook, exit 0).

Reproduce (guest, plugin root `$P`):

```sh
J='{"sessionId":"t","cwd":"/home/agent/workspace","toolCalls":[{"id":"c1","name":"apply_patch","args":"*** Begin Patch\n*** Add File: /home/agent/workspace/hello.txt\n+hello\n*** End Patch\n"}]}'
printf '%s' "$J" | CITADEL_RUNTIME=copilot node "$P/hooks_src/copilot-adapter.js" protect-files preToolUse; echo "exit=$?"
```

Related packaging warnings from the same Copilot log (Agent Plugins v1 `$schema`):
- MCP servers are read only from `mcp.json`; `.mcp.json` at the plugin root is no longer read.
- Agents are read only from `com.github.copilot/agents`; `agents/` at the plugin root is no
  longer read (Citadel's agents are not loaded under Copilot).

## Acceptance Criteria

- `normalizeCopilotHookInput` accepts the batched `toolCalls` form; each call is projected
  (tool-name mapping incl. `apply_patch` with raw-string `args` -> `tool_input.command`).
- Security hooks evaluate every call in a batch; any denial denies the batch; an unknown or
  unparseable call still fails closed.
- Tests for the batched shape (single and multiple calls, apply_patch Add/Update/Delete, mixed
  allowed/denied), plus the existing single-tool shape.
- Plugin layout matches Agent Plugins v1 (`mcp.json`, `com.github.copilot/agents`) or drops
  the `$schema` declaration; Copilot's loader warnings are gone.

## Resolution

- `runtimes/copilot/adapters/hook-input.js`: new `normalizeCopilotHookInputs` splits a `toolCalls`
  batch into one envelope per call (shared session fields, per-call `toolCallId`). Raw-string
  `apply_patch` args are wrapped as `tool_input.command`, for both the batched and the
  single-tool shape; other unparseable string args still fail closed.
- `hooks_src/copilot-adapter.js`: security hooks validate every call before anything runs, and
  every call is projected and evaluated, so one denied, unknown or unreadable call denies the
  batch. `mergeOutputs` keeps the most restrictive decision (deny > ask > allow, block > allow)
  with its reason, so a later allow can no longer overwrite a deny.
- `plugin.json`: dropped the Agent Plugins v1 `$schema`, so Copilot no longer expects
  `mcp.json` / `com.github.copilot/agents`. The root `.mcp.json` declares no servers, so no MCP
  server is lost. Loading Citadel agents under Copilot is tracked separately in
  `copilot-agents-packaging.md`.
- Tests in `scripts/test-copilot-runtime.js`: batched single and multi-call, apply_patch
  Add/Update/Delete (allowed and `.env` denied), deny in either batch position, fail-closed on
  unknown tool, unparseable args, missing patch boundaries, non-object call, empty and non-array
  `toolCalls`, decision precedence in `mergeOutputs`, and no `$schema` in `plugin.json`. The
  tests fail against the previous adapter.
- Not verified against a live Copilot CLI here; re-run the reproduce command in the AgentSandbox
  `github-copilot-citadel` profile to confirm.
