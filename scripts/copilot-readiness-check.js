#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateCopilotConfig } = require('../runtimes/copilot/generators/install-hooks');
const { countCitadelHooks } = require('../runtimes/copilot/generators/install-hooks');
const {
  isCitadelPluginEnabled,
  writeCopilotPluginHooks,
} = require('../runtimes/copilot/generators/plugin');
const runtime = require('../runtimes/copilot/runtime');

function arg(argv, name, fallback = null) {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function check(name, pass, detail, required = true) {
  return { name, pass: Boolean(pass), detail: detail || '', required };
}

function hasLegacyClaudeConflict(projectRoot) {
  const file = path.join(projectRoot, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    return JSON.stringify(settings.hooks || {}).includes('hooks_src/')
      && settings.env?.CITADEL_RUNTIME !== 'claude-code';
  } catch {
    return true;
  }
}

function collect(projectRoot) {
  const root = path.resolve(projectRoot);
  const checks = [];
  const settingsPath = path.join(root, '.github', 'copilot', 'settings.local.json');
  let settings = null;
  let settingsError = null;
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      validateCopilotConfig(settings);
    } catch (error) {
      settingsError = error.message;
    }
  }
  const fallbackCount = settingsError ? 0 : countCitadelHooks(settings?.hooks || {});
  const pluginList = spawnSync('copilot', ['plugin', 'list'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  const pluginInstalled = pluginList.status === 0
    && isCitadelPluginEnabled(pluginList.stdout);
  const mode = pluginInstalled ? 'plugin' : fallbackCount > 0 ? 'project-fallback' : 'missing';
  checks.push(check(
    'exactly one Copilot hook source active',
    (pluginInstalled ? 1 : 0) + (fallbackCount > 0 ? 1 : 0) === 1,
    `mode=${mode}; plugin=${pluginInstalled}; fallback registrations=${fallbackCount}`,
  ));
  checks.push(check(
    'Copilot fallback settings valid',
    mode !== 'project-fallback' || !settingsError,
    settingsError || settingsPath,
  ));
  let pluginConfigValid = false;
  try {
    const pluginHooks = writeCopilotPluginHooks({
      citadelRoot: path.resolve(__dirname, '..'),
      check: true,
    });
    pluginConfigValid = !pluginHooks.changed && pluginHooks.config.version === 1;
  } catch (error) {
    settingsError = error.message;
  }
  checks.push(check(
    'native Copilot plugin hooks valid',
    mode !== 'plugin' || pluginConfigValid,
    settingsError || 'com.github.copilot/hooks/hooks.json',
  ));
  checks.push(check(
    'Copilot hooks explicitly select their runtime',
    mode !== 'project-fallback' || Object.values(settings?.hooks || {}).flat()
      .filter((entry) => JSON.stringify(entry).includes('copilot-adapter'))
      .every((entry) => entry.env?.CITADEL_RUNTIME === 'copilot'),
    'each fallback command sets CITADEL_RUNTIME=copilot',
  ));
  checks.push(check(
    'legacy Claude hook conflict absent',
    !hasLegacyClaudeConflict(root),
    'legacy Citadel hooks in .claude/settings.json must set CITADEL_RUNTIME=claude-code',
  ));
  checks.push(check(
    'AGENTS.md available',
    fs.existsSync(path.join(root, 'AGENTS.md')),
    'Copilot reads shared AGENTS.md guidance',
    false,
  ));

  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-copilot-readiness-'));
  try {
    fs.writeFileSync(path.join(probe, '.env'), 'SECRET=1\n');
    const adapter = path.join(__dirname, '..', 'hooks_src', 'copilot-adapter.js');
    const result = spawnSync(process.execPath, [adapter, 'protect-files', 'preToolUse'], {
      cwd: probe,
      input: JSON.stringify({
        sessionId: 'readiness',
        timestamp: Date.now(),
        cwd: probe,
        toolName: 'view',
        toolArgs: JSON.stringify({ path: path.join(probe, '.env') }),
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    checks.push(check('pre-tool gate blocks a .env read', result.status === 2, result.stderr || `exit ${result.status}`));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  return checks;
}

function summarize(checks, strict = false) {
  const blocking = checks.filter((item) => !item.pass && item.required);
  const warnings = checks.filter((item) => !item.pass && !item.required);
  return { blocking, warnings, ok: blocking.length === 0 && (!strict || warnings.length === 0) };
}

function run(argv = process.argv.slice(2)) {
  const projectRoot = path.resolve(arg(argv, '--project-root', process.cwd()));
  const strict = argv.includes('--strict');
  const checks = collect(projectRoot);
  return { projectRoot, strict, ...summarize(checks, strict), checks, degradations: runtime.degradations };
}

function main() {
  const report = run();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const item of report.checks) process.stdout.write(`${item.pass ? 'PASS' : item.required ? 'FAIL' : 'WARN'} ${item.name}: ${item.detail}\n`);
    process.stdout.write(report.ok ? 'READY\n' : 'NOT READY\n');
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = Object.freeze({ collect, hasLegacyClaudeConflict, main, run, summarize });
