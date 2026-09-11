'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = require('../../package.json').version;
const EXIT = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 64, UNAVAILABLE: 78 });
const CODE = Object.freeze({
  RUNTIME_NOT_FOUND: 'CITADEL_RUNTIME_NOT_FOUND',
  RUNTIME_AMBIGUOUS: 'CITADEL_RUNTIME_AMBIGUOUS',
  FEATURE_UNAVAILABLE: 'CITADEL_FEATURE_UNAVAILABLE',
  COMMAND_FAILED: 'CITADEL_COMMAND_FAILED',
});

const HELP = `Citadel ${VERSION}

Usage: citadel <command> [options]

Commands:
  install      Legacy runtime-package installer; prefer adopt plan/apply
  doctor       Check package integrity and runtime availability
  update       Plan/apply a receipt-owned update
  rollback     Plan/apply a receipt-owned rollback
  uninstall    Compatibility alias for receipt-owned adopt leave
  pack         Inspect, verify, certify, install, or remove outcome Packs
  journey      Start or complete a receipt-backed Pack journey
  receipt      Verify an operation receipt offline
  fork         Run one operation through comparable isolated runtimes
  adopt        Plan, apply, inspect, evolve, or leave a governed adoption
  config       Inspect or change the versioned operating profile and bundles
  governance   Record or authorize a fail-honest governance decision
  control-plane Run the Governance Port alpha or its conformance suite
  trial        Operate the local-only Real User Proof v2 instrument
  memory       Preserve durable Citadel knowledge across disposable clones
  operation    Plan, run, explain, or verify a constrained execution path
  help         Show this help

Run citadel <command> --help for command-specific help.
`;

const COMMAND_HELP = Object.freeze({
  install: `Usage: citadel install [--runtime claude|codex] [--project-root PATH] [--dry-run] [--json]

Runtime is selected from --runtime, CITADEL_RUNTIME, project markers, or an
installed Claude Code or Codex command. Ambiguous detection fails closed.
This is the one-major legacy runtime-package adapter. New project adoption uses
citadel adopt plan|apply so every mutation and later leave is receipt-owned.
`,
  doctor: 'Usage: citadel doctor [--project-root PATH] [--runtime claude|codex] [--json]\n',
  update: 'Usage: citadel update <plan SOURCE --migration FILE | apply PLAN> [options]\n',
  rollback: 'Usage: citadel rollback <plan | apply PLAN> [options]\n',
  uninstall: 'Usage: citadel uninstall [PROJECT] [--project-root PATH] [--dry-run] [--json]\n       citadel uninstall --apply --plan PLAN [--confirm TOKEN] [--json]\n',
  pack: 'Usage: citadel pack <list|inspect|verify|certify|install|installed|uninstall> [options]\n',
  journey: 'Usage: citadel journey <start|complete> --run-id ID [--pack NAME --runtime RUNTIME | --evidence FILE]\n',
  receipt: 'Usage: citadel receipt verify --input FILE [--public-key FILE]\n',
  fork: 'Usage: citadel fork <start|resume|status|compare|select|land|replay> [options]\n',
  adopt: 'Usage: citadel adopt <plan|apply|doctor|update|rollback|restore|import|leave> [options]\n',
  config: 'Usage: citadel config <show|check|reconcile|initialize|plan|migrate|set-profile|enable|disable> [options]\n',
  governance: 'Usage: citadel governance <evaluate|authorize|check> [options]\n',
  'control-plane': 'Usage: citadel control-plane <stdio|conformance> [options]\n',
  trial: 'Usage: citadel trial <validate|plan|start|record|report|share-preview|purge> [options]\n',
  memory: 'Usage: citadel memory <status|enable|sync|restore|versions|restore-version|disable|purge> [options]\n',
  operation: 'Usage: citadel operation <init|catalog|plan|explain|run|verify|doctor> [options]\n',
});

function has(args, flag) {
  return args.includes(flag);
}

function value(args, flag, fallback = null) {
  const inline = args.find((item) => item.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function stripFlag(args, flag, takesValue = false) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === flag) {
      if (takesValue) index += 1;
      continue;
    }
    if (item.startsWith(`${flag}=`)) continue;
    output.push(item);
  }
  return output;
}

function normalizeRuntime(input) {
  const runtime = String(input || '').trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'claude-code') return 'claude';
  if (runtime === 'codex') return 'codex';
  if (runtime === 'opencode') return 'opencode';
  return null;
}

function commandAvailable(command, spawn = spawnSync) {
  const executable = process.platform === 'win32' ? 'where.exe' : command;
  const args = process.platform === 'win32' ? [command] : ['--version'];
  const result = spawn(executable, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return !result.error && result.status === 0;
}

function markerRuntimes(projectRoot, fsImpl = fs) {
  const found = [];
  if (fsImpl.existsSync(path.join(projectRoot, '.claude'))) found.push('claude');
  if (fsImpl.existsSync(path.join(projectRoot, '.codex'))) found.push('codex');
  if (fsImpl.existsSync(path.join(projectRoot, '.opencode'))) found.push('opencode');
  return found;
}

function runtimeError(code, candidates = []) {
  const messages = {
    [CODE.RUNTIME_NOT_FOUND]: 'Could not detect Claude Code, Codex, or opencode. Install a runtime or pass --runtime.',
    [CODE.RUNTIME_AMBIGUOUS]: 'More than one runtime is available. Pass --runtime to choose one.',
  };
  const error = new Error(messages[code]);
  error.code = code;
  error.candidates = candidates;
  return error;
}

function detectRuntime(args, options = {}) {
  const explicitRaw = value(args, '--runtime');
  if (explicitRaw !== null) {
    const explicit = normalizeRuntime(explicitRaw);
    if (!explicit) throw runtimeError(CODE.RUNTIME_NOT_FOUND, [explicitRaw]);
    return { runtime: explicit, source: 'argument' };
  }

  const fromEnvironment = normalizeRuntime((options.env || process.env).CITADEL_RUNTIME);
  if (fromEnvironment) return { runtime: fromEnvironment, source: 'environment' };

  const projectRoot = path.resolve(value(args, '--project-root', value(args, '--target-project', options.cwd || process.cwd())));
  const markers = markerRuntimes(projectRoot, options.fsImpl || fs);
  if (markers.length === 1) return { runtime: markers[0], source: 'project-marker' };
  if (markers.length > 1) throw runtimeError(CODE.RUNTIME_AMBIGUOUS, markers);

  const probe = options.probe || ((command) => commandAvailable(command, options.spawn || spawnSync));
  const available = [
    probe('claude') ? 'claude' : null,
    probe('codex') ? 'codex' : null,
    probe('opencode') ? 'opencode' : null,
  ].filter(Boolean);
  if (available.length === 1) return { runtime: available[0], source: 'command' };
  if (available.length > 1) throw runtimeError(CODE.RUNTIME_AMBIGUOUS, available);
  throw runtimeError(CODE.RUNTIME_NOT_FOUND);
}

function writeJson(io, valueToWrite) {
  io.stdout.write(`${JSON.stringify(valueToWrite, null, 2)}\n`);
}

function reportError(io, json, error, command) {
  const code = error.code || CODE.COMMAND_FAILED;
  const payload = { ok: false, command, code, message: error.message };
  if (error.candidates?.length) payload.candidates = error.candidates;
  if (json) writeJson(io, payload);
  else io.stderr.write(`citadel ${command}: ${error.message} [${code}]\n`);
  return error.exitCode || EXIT.FAILURE;
}

function child(script, args, options = {}) {
  const spawn = options.spawn || spawnSync;
  const json = Boolean(options.json);
  const result = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: options.cwd || process.cwd(),
    encoding: json ? 'utf8' : undefined,
    shell: false,
    stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (json) {
    if (result.stdout) options.io.stdout.write(result.stdout);
    if (result.stderr) options.io.stderr.write(result.stderr);
  }
  if (result.error) {
    const error = new Error(result.error.message);
    error.code = CODE.COMMAND_FAILED;
    throw error;
  }
  return Number.isInteger(result.status) ? result.status : EXIT.FAILURE;
}

function install(args, context) {
  const json = has(args, '--json');
  let detection;
  try {
    detection = detectRuntime(args, context);
  } catch (error) {
    return reportError(context.io, json, error, 'install');
  }
  let forwarded = stripFlag(args, '--runtime', true);
  forwarded = forwarded.filter((item) => !item.startsWith('--runtime='));
  if (detection.runtime === 'claude' && !has(forwarded, '--install') && !has(forwarded, '--add-marketplace')) {
    forwarded.push('--install', '--scope', 'local');
  }
  if (detection.runtime === 'codex' && !has(forwarded, '--plugin-only') && !has(forwarded, '--add-marketplace') && !has(forwarded, '--install')) {
    forwarded.push('--install');
  }
  if (!json) context.io.stdout.write(`Citadel selected ${detection.runtime} from ${detection.source}.\n`);
  try {
    return child('install.js', ['--runtime', detection.runtime, ...forwarded], { ...context, json });
  } catch (error) {
    return reportError(context.io, json, error, 'install');
  }
}

function doctorReport(args, context = {}) {
  const packageFiles = [
    'package.json', 'scripts/install.js', 'scripts/claude-install.js',
    'scripts/codex-install.js', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
  ];
  const fsImpl = context.fsImpl || fs;
  const checks = packageFiles.map((relative) => ({
    name: `package:${relative}`,
    pass: fsImpl.existsSync(path.join(ROOT, relative)),
  }));
  const major = Number(process.versions.node.split('.')[0]);
  checks.unshift({ name: 'node>=22', pass: major >= 22, value: process.versions.node });
  let detection = null;
  let runtimeErrorCode = null;
  try {
    detection = detectRuntime(args, context);
  } catch (error) {
    runtimeErrorCode = error.code;
  }
  checks.push({
    name: 'runtime-selection',
    pass: Boolean(detection),
    runtime: detection?.runtime || null,
    source: detection?.source || null,
    code: runtimeErrorCode,
  });
  if (detection) {
    const probe = context.probe || ((command) => commandAvailable(command, context.spawn || spawnSync));
    checks.push({
      name: 'runtime-command',
      // The normalized runtime id is also the CLI binary name for every runtime
      // the installer supports, so probe it directly rather than mapping.
      pass: probe(detection.runtime),
      runtime: detection.runtime,
    });
  }
  return { schema: 1, command: 'doctor', version: VERSION, pass: checks.every((check) => check.pass), checks };
}

function doctor(args, context) {
  const report = doctorReport(args, context);
  if (has(args, '--json')) writeJson(context.io, report);
  else {
    context.io.stdout.write(`Citadel doctor ${VERSION}\n`);
    for (const check of report.checks) context.io.stdout.write(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.runtime ? ` (${check.runtime})` : ''}\n`);
  }
  return report.pass ? EXIT.OK : EXIT.FAILURE;
}

function uninstall(args, context) {
  const json = has(args, '--json');
  const dryRun = has(args, '--dry-run');
  const configured = value(args, '--project-root', value(args, '--target-project'));
  const positional = args.find((item, index) => !item.startsWith('-') && (index === 0 || !['--project-root', '--target-project'].includes(args[index - 1])));
  const projectRoot = path.resolve(configured || positional || context.cwd || process.cwd());
  if (has(args, '--export-only')) {
    const forwarded = [projectRoot, '--export-only'];
    return child('unharness.js', forwarded, { ...context, json: false });
  }
  if (has(args, '--apply')) {
    const planFile = value(args, '--plan');
    if (!planFile) {
      const error = new Error('uninstall --apply requires --plan <saved leave plan>');
      error.code = CODE.COMMAND_FAILED;
      error.exitCode = EXIT.USAGE;
      return reportError(context.io, json, error, 'uninstall');
    }
    const forwarded = ['leave', 'apply', path.resolve(context.cwd, planFile)];
    const confirmation = value(args, '--confirm');
    if (confirmation) forwarded.push('--confirm', confirmation);
    if (json) forwarded.push('--json');
    return child('adopt.js', forwarded, { ...context, json });
  }
  const forwarded = ['leave', 'plan', '--target', projectRoot];
  const controlRoot = value(args, '--control-root');
  if (controlRoot) forwarded.push('--control-root', controlRoot);
  if (json || dryRun) forwarded.push('--json');
  return child('adopt.js', forwarded, { ...context, json: json || dryRun });
}

function controlPlane(args, context) {
  const command = args[0];
  if (command === 'conformance') {
    return child('control-plane-conformance.js', args.slice(1), {
      ...context,
      json: has(args, '--json'),
    });
  }
  if (command === 'stdio') {
    return child('control-plane-stdio.js', args.slice(1), { ...context, json: false });
  }
  const error = new Error('control-plane requires stdio or conformance');
  error.code = CODE.COMMAND_FAILED;
  error.exitCode = EXIT.USAGE;
  return reportError(context.io, has(args, '--json'), error, 'control-plane');
}

function unavailable(command, args, context) {
  if (has(args, '--help') || has(args, '-h')) {
    context.io.stdout.write(COMMAND_HELP[command]);
    return EXIT.OK;
  }
  const error = new Error(`${command} support is not available in Citadel ${VERSION}`);
  error.code = CODE.FEATURE_UNAVAILABLE;
  error.exitCode = EXIT.UNAVAILABLE;
  return reportError(context.io, has(args, '--json'), error, command);
}

function main(argv = process.argv.slice(2), options = {}) {
  const context = {
    io: options.io || { stdout: process.stdout, stderr: process.stderr },
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    fsImpl: options.fsImpl || fs,
    spawn: options.spawn || spawnSync,
    probe: options.probe,
  };
  const command = argv[0] || 'help';
  const args = argv.slice(1);
  if (command === 'help' || command === '--help' || command === '-h') {
    context.io.stdout.write(HELP);
    return EXIT.OK;
  }
  if (command === '--version' || command === 'version') {
    context.io.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (COMMAND_HELP[command] && (has(args, '--help') || has(args, '-h'))) {
    context.io.stdout.write(COMMAND_HELP[command]);
    return EXIT.OK;
  }
  if (command === 'install') return install(args, context);
  if (command === 'doctor') return doctor(args, context);
  if (command === 'update' || command === 'rollback') {
    if (['plan', 'apply'].includes(args[0])) {
      return child('adopt.js', [command, ...args], {
        ...context,
        json: has(args, '--json'),
      });
    }
    const error = new Error(
      `${command} is receipt-owned; use citadel ${command} plan|apply`,
    );
    error.code = CODE.COMMAND_FAILED;
    error.exitCode = EXIT.USAGE;
    return reportError(context.io, has(args, '--json'), error, command);
  }
  if (command === 'uninstall') return uninstall(args, context);
  if (command === 'pack') return child('packs.js', args, { ...context, json: has(args, '--json') });
  if (command === 'journey') return child('start-journey.js', args, { ...context, json: has(args, '--json') });
  if (command === 'receipt') return child('receipt.js', args, { ...context, json: has(args, '--json') });
  if (command === 'fork') return child('operation-fork.js', args, { ...context, json: true });
  if (command === 'adopt') return child('adopt.js', args, { ...context, json: has(args, '--json') });
  if (command === 'config') return child('citadel-config.js', args, { ...context, json: has(args, '--json') });
  if (command === 'governance') return child('governance-gate.js', args, { ...context, json: has(args, '--json') });
  if (command === 'control-plane') return controlPlane(args, context);
  if (command === 'trial') return child('product-proof-trial.js', args, { ...context, json: true });
  if (command === 'memory') return child('repository-memory.js', args, { ...context, json: has(args, '--json') });
  if (command === 'operation') return child('operation.js', args, { ...context, json: has(args, '--json') });
  const error = new Error(`unknown command: ${command}`);
  error.code = CODE.COMMAND_FAILED;
  error.exitCode = EXIT.USAGE;
  return reportError(context.io, has(args, '--json'), error, command);
}

module.exports = {
  CODE, COMMAND_HELP, EXIT, HELP, ROOT, VERSION,
  commandAvailable, detectRuntime, doctorReport, main, markerRuntimes, normalizeRuntime,
};
