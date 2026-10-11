#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { reconcileEffectiveConfig } = require('../core/config');
const { installCopilotHooks } = require('../runtimes/copilot/generators/install-hooks');
const copilotRuntime = require('../runtimes/copilot/runtime');

const CITADEL_ROOT = path.resolve(__dirname, '..');

function arg(argv, name, fallback = null) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function run(argv = process.argv.slice(2)) {
  const projectRoot = path.resolve(arg(argv, '--project-root', argv.find((item) => !item.startsWith('-')) || process.cwd()));
  const dryRun = argv.includes('--dry-run');
  const resolved = dryRun ? null : reconcileEffectiveConfig(projectRoot, { runtime: copilotRuntime });
  if (resolved?.receipt.status === 'blocked') {
    throw new Error(`Harness config blocks hook installation: ${resolved.receipt.errors.join('; ')}`);
  }
  return installCopilotHooks({
    citadelRoot: CITADEL_ROOT,
    projectRoot,
    dryRun,
    effectiveBundles: resolved?.receipt.bundles.effective,
  });
}

function main() {
  try {
    const result = run();
    const json = process.argv.includes('--json');
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Citadel Copilot hooks ${result.machineLocalExcludes?.reason === 'dry-run' ? 'planned for' : 'installed to'} ${result.settingsPath}\n`);
    process.stdout.write(`  ${result.installed.length} registrations, ${result.skipped.length} unsupported mappings\n`);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ arg, main, run });
