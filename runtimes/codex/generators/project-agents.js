#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { projectAgentToCodex } = require('../../../core/agents/project-agent');
const { loadCodexAgentConfig } = require('../../../core/agents/model-config');

function projectCodexAgents(options = {}) {
  const citadelRoot = options.citadelRoot || path.resolve(__dirname, '..', '..', '..');
  const projectRoot = options.projectRoot || process.cwd();
  const agentName = options.agentName || null;
  const dryRun = options.dryRun === true;
  const agentConfig = options.agentConfig || loadCodexAgentConfig(projectRoot);

  const sourceBase = path.join(citadelRoot, '.citadel', 'agents');
  const targetBase = path.join(projectRoot, '.codex', 'agents');
  const agentFiles = agentName
    ? [`${agentName}.md`]
    : fs.readdirSync(sourceBase).filter((name) => name.endsWith('.md'));

  return agentFiles.map((agentFile) => projectAgentToCodex(path.join(sourceBase, agentFile), targetBase, {
    dryRun,
    agentConfig,
  }));
}

module.exports = Object.freeze({
  projectCodexAgents,
});
