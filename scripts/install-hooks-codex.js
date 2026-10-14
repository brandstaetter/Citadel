#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { reconcileEffectiveConfig, loadResolvedConfig } = require('../core/config');
const { writeJson } = require('../core/hooks/install');
const { inspectCodexHookOwnership, assertUnambiguous, assertNoPluginHooks } = require('../runtimes/codex/generators/hook-ownership');
const { installCodexHooks } = require('../runtimes/codex/generators/install-hooks');
const codexRuntime = require('../runtimes/codex/runtime');

const CITADEL_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const JSON_OUTPUT = args.includes('--json');
const DRY_RUN = args.includes('--dry-run');
const REMOVE_LOCAL = args.includes('--remove-local');
const PROJECT_ROOT = args.find((a) => !a.startsWith('-')) || process.cwd();

function main() {
  try {
    if (args.includes('--help')) {
      console.log('Usage: node scripts/install-hooks-codex.js [PROJECT_ROOT] [--dry-run] [--remove-local] [--json]\n'
        + 'Default: replace verified direct/adapter Citadel handlers with current adapter hooks.\n'
        + '--remove-local: remove only verified Citadel handlers before plugin installation.\n'
        + 'Ambiguous handlers block writes. Unrelated handlers and top-level settings are preserved.');
      return;
    }
    const hooksTemplatePath = path.join(CITADEL_ROOT, 'hooks', 'hooks-template.json');
    const hooksTemplate = JSON.parse(fs.readFileSync(hooksTemplatePath, 'utf8'));
    const adapterScriptPath = path.join(CITADEL_ROOT, 'hooks_src', 'codex-adapter.js');
    const outputPath = path.join(PROJECT_ROOT, '.codex', 'hooks.json');
    const existingConfig = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : {};
    const existingHooks = existingConfig.hooks || {};
    const ownership = inspectCodexHookOwnership(existingHooks, { hooksTemplate, adapterScriptPath });
    assertUnambiguous(ownership);
    if (!REMOVE_LOCAL) assertNoPluginHooks(PROJECT_ROOT);
    const preview = loadResolvedConfig(PROJECT_ROOT, { runtime: codexRuntime });
    if (!REMOVE_LOCAL && preview.receipt.status === 'blocked') {
      throw new Error(`Harness config blocks hook installation: ${preview.receipt.errors.join('; ')}`);
    }
    const backupPath = `${outputPath}.pre-citadel-migration`;
    if (!DRY_RUN && ownership.owned.length && !fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, fs.readFileSync(outputPath), { flag: 'wx' });
    }
    if (REMOVE_LOCAL) {
      if (!DRY_RUN && ownership.owned.length) writeJson(outputPath, { ...existingConfig, hooks: ownership.preserved });
      const report = { outputPath, backupPath, dryRun: DRY_RUN, mode: 'remove-local', ownership };
      console.log(JSON_OUTPUT ? JSON.stringify(report, null, 2) : `${DRY_RUN ? 'Would remove' : 'Removed'} ${ownership.owned.length} verified Citadel handlers; user handlers preserved.`);
      return;
    }
    const resolved = DRY_RUN ? preview : reconcileEffectiveConfig(PROJECT_ROOT, { runtime: codexRuntime });

    const result = installCodexHooks({
      hooksTemplate,
      adapterScriptPath,
      existingHooks,
      outputPath,
      projectRoot: PROJECT_ROOT,
      effectiveBundles: resolved.receipt.bundles.effective,
      dryRun: DRY_RUN,
    });

    if (JSON_OUTPUT) {
      process.stdout.write(JSON.stringify({
        outputPath,
        dryRun: DRY_RUN,
        backupPath,
        ownership: result.ownership,
        installed: result.installed,
        skipped: result.skipped,
        warnings: result.warnings || [],
        diagnostics: result.diagnostics || [],
        outputs: result.outputs || [],
        machineLocalExcludes: result.machineLocalExcludes || null,
        effectiveBundles: resolved.receipt.bundles.effective,
      }, null, 2) + '\n');
      return;
    }

    console.log(`Citadel Codex hooks ${DRY_RUN ? 'would be installed' : 'installed'} to ${outputPath}`);
    console.log(`  ${result.installed.length} Citadel hooks translated for Codex`);
    console.log(`  Product bundles: ${resolved.receipt.bundles.effective.join(', ')}`);
    if (result.diagnostics?.length) {
      for (const diagnostic of result.diagnostics) {
        console.log(`  Diagnostic: ${diagnostic.message}`);
      }
    }
    if (result.machineLocalExcludes?.written) {
      console.log(`  Machine-local outputs protected by ${result.machineLocalExcludes.path}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  ${result.skipped.length} hook mappings skipped due to missing Codex lifecycle equivalents`);
    }

    if (VERBOSE) {
      if (result.installed.length > 0) {
        console.log('\nInstalled:');
        for (const entry of result.installed) {
          console.log(`  - ${entry.hook} (${entry.event})`);
        }
      }
      if (result.skipped.length > 0) {
        console.log('\nSkipped:');
        for (const entry of result.skipped) {
          console.log(`  - ${entry.hook} (Citadel event: ${entry.event}) — ${entry.reason}`);
        }
      }
      if (result.warnings && result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
    }
  } catch (error) {
    if (JSON_OUTPUT) console.log(JSON.stringify({ pass: false, code: error.code || 'CODEX_HOOK_INSTALL_FAILED', message: error.message, diagnostics: error.diagnostics || [] }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
