#!/usr/bin/env node

'use strict';

module.exports = Object.freeze({
  id: 'copilot',
  displayName: 'GitHub Copilot',
  capabilities: {
    guidance: { support: 'full', notes: 'Reads AGENTS.md and repository custom instructions.' },
    skills: { support: 'full', notes: 'Uses repository skills and skills contributed by installed plugins.' },
    agents: { support: 'full', notes: 'Uses repository custom agents from .github/agents and plugin agents.' },
    hooks: { support: 'partial', notes: 'Supports command hooks across tool, session, prompt, compaction, notification, and agent lifecycles. Command failures deny pre-tool use, but hook timeouts fail open.' },
    workspace: { support: 'full', notes: 'Provides file, shell, and project workspace tools in CLI and cloud-agent environments.' },
    worktrees: { support: 'partial', notes: 'Citadel-managed worktrees remain the portable integration path.' },
    approvals: { support: 'partial', notes: 'CLI permission hooks can decide requests; cloud-agent calls are pre-approved and must be gated in preToolUse.' },
    history: { support: 'partial', notes: 'Session history is runtime-owned while campaign state remains Citadel-owned.' },
    telemetry: { support: 'partial', notes: 'Lifecycle events are normalized through the Copilot hook adapter.' },
    mcp: { support: 'full', notes: 'Copilot CLI supports project and user MCP configuration.' },
    surfaces: { support: 'full', notes: 'Supports CLI hooks, custom agents, skills, instructions, MCP, and native plugins.' },
  },
  degradations: [
    'hook-timeouts-fail-open',
    'cloud-permission-request-not-enforced',
    'worktree-lifecycle-not-native',
  ],
});
