'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const config = require('../core/config');
const launcher = require('../core/forks/launcher');
const repo = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
const version = readJson('package.json').version;

for (const file of ['citadel-metadata.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  assert.equal(readJson(file).version, version, file + ' release version drift');
}
const lock = readJson('package-lock.json');
assert.equal(lock.version, version);
assert.equal(lock.packages[''].version, version);
for (const file of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
  assert.equal(readJson(file).plugins.find(plugin => plugin.name === 'citadel').version, version, file);
}
for (const file of ['README.md', 'INSTALL.md', 'docs/RELEASES.md']) {
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').split('\n').filter(line => /marketplace add|Install Citadel v|^TAG=|release-verify\.js|--ref v|--version \d|attestation verify|update\.js --archive/.test(line));
  assert(lines.length > 0, file);
  for (const line of lines) for (const match of line.matchAll(/\b(\d+\.\d+\.\d+)\b/g)) assert.equal(match[1], version, file + ': ' + line);
}
assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+) /m)?.[1], version);

function mockClaude(env, platform, resolved) {
  let observed;
  const context = { module: { exports: {} }, process: { env }, require(name) {
    if (name === 'child_process') return { spawnSync(command, args, options) { observed = { command, args, options }; return { status: 0 }; } };
    if (name === './launcher') return { platformInvocation(invocation, options) { return launcher.platformInvocation(invocation, { ...options, platform, resolve: () => resolved, exists: () => true, nodePath: 'node' }); } };
    throw Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'core/forks/claude-launcher.js'), 'utf8'), context);
  context.module.exports.spawnClaudeSync(['-p', 'literal & prompt'], { encoding: 'utf8', shell: true });
  return observed;
}
assert.equal(mockClaude({}, 'linux').command, 'claude');
assert.equal(mockClaude({ CITADEL_CLAUDE_BIN: '/opt/custom/claude' }, 'linux').command, '/opt/custom/claude');
const win = mockClaude({}, 'win32', 'C:\\user space\\npm\\claude.cmd');
assert.equal(win.command, 'node');
assert.equal(win.args[0], 'C:\\user space\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
assert.equal(win.args[2], 'literal & prompt');
assert.equal(win.options.shell, false);
assert.equal(mockClaude({ CITADEL_CLAUDE_BIN: 'D:\\tools\\claude.exe' }, 'win32', 'D:\\tools\\claude.exe').command, 'D:\\tools\\claude.exe');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-version-upgrade-'));
try {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '.citadel/scripts'), { recursive: true });
  const harness = config.createDefaultConfig();
  harness.activation = { bundles: config.dependencyClosure(['parallel']), onDemand: 'prompt', allowDegradedRuntime: true };
  fs.writeFileSync(path.join(root, '.claude/harness.json'), JSON.stringify(harness));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CITADEL_RUNTIME: 'claude-code' };
  const stale = path.join(root, 'stale-delegate-executed');
  fs.writeFileSync(path.join(root, '.citadel/scripts/coordination.js'), `require('fs').writeFileSync(${JSON.stringify(stale)}, 'old');`);
  fs.writeFileSync(path.join(root, '.citadel/version.txt'), '1.3.5\n');
  fs.writeFileSync(path.join(root, '.citadel/plugin-root.txt'), path.join(root, 'removed-plugin'));
  function init() {
    const result = spawnSync(process.execPath, [path.join(repo, 'hooks_src/init-project.js')], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, '.citadel/version.txt'), 'utf8').trim(), version);
    assert.equal(fs.readFileSync(path.join(root, '.citadel/plugin-root.txt'), 'utf8').trim(), repo);
  }
  init();
  assert(!fs.existsSync(stale), 'upgrade initialization must not execute a delegate from the previous plugin version');
  // ESM projects must still be able to execute CommonJS delegates after a bump.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(root, '.citadel/plugin-root.txt'), path.join(root, 'same-version-old-location'));
  init();
  const health = spawnSync(process.execPath, [path.join(root, '.citadel/scripts/health.js')], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(health.status, 0, health.stderr);
  assert(JSON.parse(health.stdout).timestamp);
  const receipt = config.reconcileEffectiveConfig(root, { runtime: config.detectRuntimeContract(root) });
  assert.equal(receipt.receipt.package.version, version);
  assert(config.readEffectiveConfig(root).usable);
  console.log('Version upgrade safety passed: release surfaces, portable launcher, old project state, relocated roots and ESM delegates.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
