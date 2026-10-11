#!/usr/bin/env node

'use strict';

const path = require('path');
const { writeCopilotPluginHooks } = require('../runtimes/copilot/generators/plugin');

function run(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const result = writeCopilotPluginHooks({
    citadelRoot: path.resolve(__dirname, '..'),
    check,
  });
  return {
    ok: !check || !result.changed,
    check,
    changed: result.changed,
    outputPath: result.outputPath,
    installed: result.installed.length,
    skipped: result.skipped,
  };
}

function main() {
  const result = run();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.check && result.changed) process.stderr.write(`Copilot plugin hooks are stale: ${result.outputPath}\n`);
  else process.stdout.write(`${result.changed ? 'Generated' : 'Verified'} ${result.outputPath}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = Object.freeze({ main, run });
