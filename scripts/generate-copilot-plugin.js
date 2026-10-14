#!/usr/bin/env node

'use strict';

const path = require('path');
const { writeCopilotPluginHooks } = require('../runtimes/copilot/generators/plugin');
const { writeCopilotPluginAgents } = require('../runtimes/copilot/generators/agents');

function run(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const result = writeCopilotPluginHooks({
    citadelRoot: path.resolve(__dirname, '..'),
    check,
  });
  const agents = writeCopilotPluginAgents({ citadelRoot: path.resolve(__dirname, '..'), check });
  return {
    ok: !check || (!result.changed && !agents.changed),
    check,
    changed: result.changed || agents.changed,
    agents,
    outputPath: result.outputPath,
    installed: result.installed.length,
    skipped: result.skipped,
  };
}

function main() {
  const result = run();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.check && result.changed) process.stderr.write(`Copilot plugin artifacts are stale: ${[result.outputPath, ...result.agents.changedPaths].join(', ')}\n`);
  else process.stdout.write(`${result.changed ? 'Generated' : 'Verified'} Copilot hooks and ${result.agents.count} agents\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = Object.freeze({ main, run });
