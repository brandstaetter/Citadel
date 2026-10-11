#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  countCitadelHooks,
  installCopilotHooks,
  removeCopilotHooks,
} = require('../runtimes/copilot/generators/install-hooks');
const {
  isCitadelPluginEnabled,
  writeCopilotPluginHooks,
} = require('../runtimes/copilot/generators/plugin');
const { inspectInstallInventory } = require('../core/runtime/install-contract');
const { readJson } = require('../core/hooks/install');
const { hasLegacyClaudeConflict } = require('./copilot-readiness-check');
const { reconcileEffectiveConfig } = require('../core/config');
const copilotRuntime = require('../runtimes/copilot/runtime');

const CITADEL_ROOT = path.resolve(__dirname, '..');

const HELP = `Usage: node scripts/copilot-install.js [options]

Options:
  --project-root <dir>   Target project (default: cwd)
  --install              Register citadel-local and install the native plugin
  --plugin-only          Validate native plugin artifacts (default)
  --fallback             Install project-local CLI hooks instead of the plugin
  --migrate-fallback     Remove only Citadel fallback hooks before plugin install
  --uninstall            Uninstall the native plugin; preserve project state
  --dry-run              Report intended mutations without writing
  --json                 Print machine-readable output
  -h, --help             Show this help
`;

function arg(argv, name, fallback = null) {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function commandStep(name, command, args, cwd, dryRun, options = {}) {
  if (dryRun) return { name, command: [command, ...args].join(' '), pass: true, skipped: true, status: 0 };
  const result = (options.spawnSync || spawnSync)(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: options.timeout || 60000,
  });
  return {
    name,
    command: [command, ...args].join(' '),
    pass: result.status === 0,
    skipped: false,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null,
  };
}

function copilotOutput(args, cwd, options = {}) {
  const result = (options.spawnSync || spawnSync)('copilot', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: 30000,
  });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function fallbackHookCount(projectRoot) {
  const settings = readJson(
    path.join(projectRoot, '.github', 'copilot', 'settings.local.json'),
    {},
    { strict: true },
  );
  return countCitadelHooks(settings.hooks || {});
}

function run(argv = process.argv.slice(2), options = {}) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const projectRoot = path.resolve(arg(argv, '--project-root', process.cwd()));
  if (!fs.existsSync(projectRoot)) return { ok: false, error: `project root does not exist: ${projectRoot}` };
  const dryRun = argv.includes('--dry-run');
  const fallback = argv.includes('--fallback');
  const install = argv.includes('--install');
  const pluginOnly = argv.includes('--plugin-only');
  const uninstall = argv.includes('--uninstall');
  const migrateFallback = argv.includes('--migrate-fallback');
  if ([fallback, install, pluginOnly, uninstall].filter(Boolean).length > 1) {
    return { ok: false, error: 'Choose only one of --install, --plugin-only, --fallback, or --uninstall.' };
  }
  if (migrateFallback && !install) {
    return { ok: false, error: '--migrate-fallback requires --install.' };
  }

  const beforeInventory = inspectInstallInventory(projectRoot, { runtime: 'copilot' });
  const steps = [];
  const diagnostics = [];
  const localHookCount = fallbackHookCount(projectRoot);
  const pluginList = dryRun ? '' : copilotOutput(['plugin', 'list'], projectRoot, options);
  const pluginInstalled = isCitadelPluginEnabled(pluginList);

  if (fallback) {
    if (pluginInstalled) {
      return {
        ok: false,
        error: 'The native Citadel plugin is enabled. Uninstall it before installing fallback hooks to avoid duplicate execution.',
        code: 'COPILOT_DUPLICATE_HOOK_REGISTRATION',
      };
    }
    const resolved = dryRun ? null : reconcileEffectiveConfig(projectRoot, { runtime: copilotRuntime });
    if (resolved?.receipt.status === 'blocked') {
      return { ok: false, error: `Harness config blocks hook installation: ${resolved.receipt.errors.join('; ')}` };
    }
    const hooks = installCopilotHooks({
      citadelRoot: CITADEL_ROOT,
      projectRoot,
      dryRun,
      effectiveBundles: resolved?.receipt.bundles.effective,
    });
    return {
      ok: true,
      mode: 'project-fallback',
      dryRun,
      projectRoot,
      steps,
      hooks: { installed: hooks.installed, skipped: hooks.skipped, warnings: hooks.warnings },
      writes: [{ action: fs.existsSync(hooks.settingsPath) ? 'update' : 'create', path: hooks.settingsPath }],
      beforeInventory,
      inventory: inspectInstallInventory(projectRoot, { runtime: 'copilot' }),
      diagnostics: hooks.diagnostics,
      outputs: hooks.outputs,
      machineLocalExcludes: hooks.machineLocalExcludes,
      degradations: copilotRuntime.degradations,
    };
  }

  if (uninstall) {
    steps.push(commandStep(
      'Uninstall Citadel native plugin',
      'copilot',
      ['plugin', 'uninstall', 'citadel'],
      projectRoot,
      dryRun,
      options,
    ));
    return {
      ok: steps.every((step) => step.pass),
      mode: 'plugin-uninstall',
      dryRun,
      projectRoot,
      steps,
      preserved: ['project files', 'Citadel state', 'user-authored hooks'],
    };
  }

  if (localHookCount > 0 && !migrateFallback) {
    return {
      ok: false,
      code: 'COPILOT_FALLBACK_MIGRATION_REQUIRED',
      error: 'Project-local Citadel hooks would duplicate native plugin hooks. Re-run --install with --migrate-fallback.',
      fallbackHooks: localHookCount,
    };
  }
  if (migrateFallback) {
    const migration = removeCopilotHooks({ projectRoot, dryRun });
    steps.push({
      name: 'Remove Citadel project fallback hooks',
      pass: true,
      skipped: !migration.changed,
      ...migration,
    });
  }

  const generated = writeCopilotPluginHooks({ citadelRoot: CITADEL_ROOT, check: dryRun });
  steps.push({
    name: 'Generate native Copilot plugin hooks',
    pass: !dryRun || !generated.changed,
    skipped: !generated.changed,
    changed: generated.changed,
    path: generated.outputPath,
  });
  if (dryRun && generated.changed) {
    diagnostics.push({ code: 'COPILOT_PLUGIN_HOOKS_STALE', message: generated.outputPath });
  }

  if (install && steps.every((step) => step.pass)) {
    const marketplaces = copilotOutput(['plugin', 'marketplace', 'list'], projectRoot, options);
    const registeredHere = marketplaces.includes('citadel-local')
      && marketplaces.toLowerCase().includes(CITADEL_ROOT.toLowerCase());
    if (!registeredHere) {
      steps.push(commandStep(
        'Register Citadel Copilot marketplace',
        'copilot',
        ['plugin', 'marketplace', 'add', CITADEL_ROOT],
        projectRoot,
        dryRun,
        options,
      ));
    }
    if (steps.every((step) => step.pass)) {
      steps.push(commandStep(
        'Install Citadel native plugin',
        'copilot',
        ['plugin', 'install', 'citadel@citadel-local'],
        projectRoot,
        dryRun,
        options,
      ));
    }
  }

  return {
    ok: steps.every((step) => step.pass),
    mode: 'plugin-only',
    dryRun,
    install,
    projectRoot,
    citadelRoot: CITADEL_ROOT,
    steps,
    beforeInventory,
    diagnostics,
    degradations: copilotRuntime.degradations,
  };
}

function main() {
  const result = run();
  if (result.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!result.ok) process.stderr.write(`${result.error || 'Copilot installation failed.'}\n`);
  else process.stdout.write(`${result.mode}: ${result.dryRun ? 'planned' : 'complete'}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = Object.freeze({
  HELP,
  commandStep,
  fallbackHookCount,
  main,
  run,
});
