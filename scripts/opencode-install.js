#!/usr/bin/env node

'use strict';

// Installs Citadel into a project for the opencode runtime.
//
// Much less work than the Codex installer, because opencode reads several Citadel
// surfaces natively:
//   guidance  AGENTS.md / CLAUDE.md            (no projection)
//   skills    .claude/skills/**/SKILL.md       (no projection)
//   commands  derived from skills by opencode   (no projection — and an explicit
//             command file would SHADOW the live skill)
// So this writes the plugin stub, merges opencode.json, and projects agents.

const fs = require('fs');
const path = require('path');

const { installOpencodePlugin } = require('../runtimes/opencode/generators/install-plugin');
const { projectOpencodeAgents } = require('../runtimes/opencode/generators/project-agents');

const CITADEL_ROOT = path.resolve(__dirname, '..');

const HELP = `Usage: node scripts/opencode-install.js [options]

Options:
  --project-root <dir>   Project to install into (default: cwd)
  --dry-run              Report every write without making it
  --skip-agents          Do not project agents into .opencode/agent
  --json                 Machine-readable output
  -h, --help             Show this help
`;

function arg(argv, name, fallback = null) {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function has(argv, name) {
  return argv.includes(name);
}

function run(argv = process.argv.slice(2)) {
  if (has(argv, '--help') || has(argv, '-h')) return { help: true };

  const projectRoot = path.resolve(arg(argv, '--project-root', process.cwd()));
  const dryRun = has(argv, '--dry-run');

  if (!fs.existsSync(projectRoot)) {
    return { ok: false, error: `project root does not exist: ${projectRoot}` };
  }

  const steps = [];
  const plugin = installOpencodePlugin({ citadelRoot: CITADEL_ROOT, projectRoot, dryRun });
  steps.push({
    step: 'plugin',
    pluginPath: plugin.pluginPath,
    configPath: plugin.configPath,
    writes: plugin.writes,
    configChanges: plugin.changes,
  });

  if (!has(argv, '--skip-agents')) {
    const agents = projectOpencodeAgents({ citadelRoot: CITADEL_ROOT, projectRoot, dryRun });
    steps.push({ step: 'agents', count: agents.length, targets: agents.map((item) => item.targetPath) });
  }

  return {
    ok: true,
    dryRun,
    projectRoot,
    citadelRoot: CITADEL_ROOT,
    steps,
    // Stated plainly so an operator is never left believing Citadel gates more
    // than it does on this runtime.
    degradations: [
      'stop-cannot-block: quality-gate findings are observational on opencode',
      'permission-gate-not-native: gating rides tool.execute.before, not permission.ask',
      'plugin-load-failure-fails-open: if opencode cannot load the plugin it continues with no Citadel hooks',
    ],
  };
}

function render(result) {
  const lines = [];
  lines.push(result.dryRun ? 'Citadel opencode install (dry run)' : 'Citadel opencode install');
  lines.push('='.repeat(40));
  lines.push(`project: ${result.projectRoot}`);
  lines.push(`citadel: ${result.citadelRoot}`);
  for (const step of result.steps) {
    if (step.step === 'plugin') {
      lines.push(`plugin:  ${step.pluginPath}`);
      lines.push(`config:  ${step.configPath}`);
      if (step.writes.length === 0) lines.push('         already up to date');
      for (const write of step.writes) {
        lines.push(`         ${write.action} ${write.path}${write.changes ? ` (${write.changes.join(', ')})` : ''}`);
      }
    }
    if (step.step === 'agents') lines.push(`agents:  ${step.count} projected into .opencode/agent`);
  }
  lines.push('');
  lines.push('Natively read by opencode, so not projected:');
  lines.push('  guidance  AGENTS.md / CLAUDE.md');
  lines.push('  skills    .claude/skills/**/SKILL.md');
  lines.push('  commands  derived from skills by opencode');
  lines.push('');
  lines.push('Known degradations on this runtime:');
  for (const item of result.degradations) lines.push(`  - ${item}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const result = run(argv);

  if (result.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!result.ok) {
    process.stderr.write(`opencode-install: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(has(argv, '--json') ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = Object.freeze({ HELP, main, render, run });
