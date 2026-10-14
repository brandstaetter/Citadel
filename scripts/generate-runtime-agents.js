#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { writeClaudeAgents } = require('../runtimes/claude-code/generators/project-agents');
const { writeCopilotPluginAgents } = require('../runtimes/copilot/generators/agents');
const { projectCodexAgents } = require('../runtimes/codex/generators/project-agents');

function writeCodexAgents(options) {
  const projected = projectCodexAgents({ ...options, dryRun: true });
  const changedPaths = [];
  for (const { output } of projected) {
    if (fs.existsSync(output.tomlPath) && fs.readFileSync(output.tomlPath, 'utf8') === output.toml) continue;
    changedPaths.push(output.tomlPath);
    if (!options.check) {
      fs.mkdirSync(path.dirname(output.tomlPath), { recursive: true });
      fs.writeFileSync(output.tomlPath, output.toml, 'utf8');
    }
  }
  return { changed: changedPaths.length > 0, changedPaths, count: projected.length };
}

function run(options = {}) {
  const results = {
    claude: writeClaudeAgents(options),
    copilot: writeCopilotPluginAgents(options),
    codex: writeCodexAgents(options),
  };
  return { ok: !options.check || Object.values(results).every(result => !result.changed), results };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') options.check = true;
    else if (argv[i] === '--project-root' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options.projectRoot = path.resolve(argv[++i]);
    } else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  const result = run(options);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
module.exports = { run };
