#!/usr/bin/env node

'use strict';

// opencode reads AGENTS.md, then CLAUDE.md (session/instruction.ts), with the
// first project-level match winning. Citadel's existing AGENTS.md renderer is
// therefore exactly right for opencode too, so this is a re-export rather than a
// second renderer — a divergent copy would drift from the Codex projection for
// no benefit.

const { renderCodexGuidance } = require('../../../core/project/render-codex-guidance');

const OPENCODE_GUIDANCE_TARGET = Object.freeze({
  runtime: 'opencode',
  filePath: 'AGENTS.md',
  render: renderCodexGuidance,
});

module.exports = Object.freeze({
  OPENCODE_GUIDANCE_TARGET,
  renderOpencodeGuidance: renderCodexGuidance,
});
