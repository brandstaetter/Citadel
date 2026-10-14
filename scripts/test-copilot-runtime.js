#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const copilot = require('../runtimes/copilot');
const {
  dispatchHook,
  mergeOutputs,
  projectCopilotOutput,
  translateOutput,
} = require('../hooks_src/copilot-adapter');
const {
  countCitadelHooks,
  installCopilotHooks,
  removeCopilotHooks,
  validateCopilotConfig,
} = require('../runtimes/copilot/generators/install-hooks');
const {
  PLUGIN_ADAPTER,
  isCitadelPluginEnabled,
  writeCopilotPluginHooks,
} = require('../runtimes/copilot/generators/plugin');
const { proposeCopilotProjection } = require('../core/adoption');
const { collect, hookSourceCheck } = require('./copilot-readiness-check');
const { projectAgent, projectAgentEntries, writeCopilotPluginAgents } = require('../runtimes/copilot/generators/agents');

// Exercise real dispatch metadata, read-only tool boundaries, and no-write checks.
const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-copilot-agents-'));
try {
  const sourceRoot = path.resolve(__dirname, '..');
  fs.cpSync(path.join(sourceRoot, '.citadel/agents'), path.join(agentRoot, '.citadel/agents'), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, 'runtimes/copilot'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'runtimes/copilot/agent-settings.json'), path.join(agentRoot, 'runtimes/copilot/agent-settings.json'));
  assert.equal(writeCopilotPluginAgents({ citadelRoot: agentRoot, check: true }).changed, true);
  assert.equal(fs.existsSync(path.join(agentRoot, 'com.github.copilot')), false);
  const generated = writeCopilotPluginAgents({ citadelRoot: agentRoot });
  assert.equal(generated.count, 7);
  assert.equal(writeCopilotPluginAgents({ citadelRoot: agentRoot, check: true }).changed, false);
  const read = name => fs.readFileSync(path.join(agentRoot, 'com.github.copilot/agents', `${name}.agent.md`), 'utf8');
  const { models } = JSON.parse(fs.readFileSync(path.join(agentRoot, 'runtimes/copilot/agent-settings.json'), 'utf8'));
  for (const name of ['archon', 'fleet', 'arbiter']) {
    assert(read(name).includes(`\nmodel: ${models[name === 'arbiter' ? 'xlarge' : 'large']}\n`));
    assert.match(read(name), /^modelPolicy: required$/m);
  }
  for (const name of ['phase-validator', 'policy-enforcer']) assert(read(name).includes(`\nmodel: ${models.small}\n`));
  assert(read('arch-reviewer').includes(`\nmodel: ${models.medium}\n`));
  assert.match(read('phase-validator'), /^tools: \["view"\]$/m);
  assert.match(read('policy-enforcer'), /^tools: \["view","glob","grep"\]$/m);
  assert.match(read('archon'), /"task"/);
  assert.match(read('archon'), /Never send a placeholder/);
  assert.match(fs.readFileSync(path.join(agentRoot, '.citadel/agents/archon.md'), 'utf8'), /^model: large\r?$/m);
  const stale = path.join(agentRoot, 'com.github.copilot/agents/stale.agent.md');
  fs.writeFileSync(stale, 'stale');
  assert.equal(writeCopilotPluginAgents({ citadelRoot: agentRoot, check: true }).changed, true);
  assert.equal(fs.readFileSync(stale, 'utf8'), 'stale');
  writeCopilotPluginAgents({ citadelRoot: agentRoot });
  assert.equal(fs.existsSync(stale), false);
  const archon = fs.readFileSync(path.join(agentRoot, '.citadel/agents/archon.md'), 'utf8');
  assert.throws(() => projectAgent('archon', archon.replace('model: large', 'model: unknown')), /Unknown model placeholder/);
  const releaseEntries = projectAgentEntries([{ name: '.citadel/agents/archon.md', data: Buffer.from(archon) }]);
  assert.deepEqual(releaseEntries.map(entry => entry.name), ['com.github.copilot/agents/archon.agent.md']);
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'plugin.json'), 'utf8'));
  assert.equal(manifest.agents, './com.github.copilot/agents');
} finally {
  fs.rmSync(agentRoot, { recursive: true, force: true });
}

const readinessProject = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-readiness-settings-'));
try {
  const settingsPath = path.join(readinessProject, '.github', 'copilot', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  for (const [settings, valid] of [
    [{ version: 1 }, true],
    [{ version: 1, hooks: {} }, true],
    [{ version: 1, hooks: null }, false],
    [{ version: 1, hooks: [] }, false],
    [{ version: 2 }, false],
    [null, false],
  ]) {
    const original = JSON.stringify(settings);
    fs.writeFileSync(settingsPath, original);
    const checks = collect(readinessProject, { copilotExecutable: path.join(readinessProject, 'missing-copilot') });
    assert.equal(checks.find(item => item.name === 'Copilot fallback settings valid').pass, valid, original);
    assert.equal(checks.find(item => item.name === 'native Copilot plugin hooks valid').detail,
      'com.github.copilot/hooks/hooks.json');
    assert.equal(checks[0].discovery, 'unavailable');
    assert.equal(checks[0].pass, false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  }
} finally {
  fs.rmSync(readinessProject, { recursive: true, force: true });
}

for (const fallbackCount of [0, 39]) {
  const unavailable = hookSourceCheck({ status: null, error: { code: 'ENOENT' } }, fallbackCount);
  assert.equal(unavailable.pass, false);
  assert.equal(unavailable.discovery, 'unavailable');
  assert(unavailable.detail.includes('plugin=unknown'));
  assert(unavailable.detail.includes('Do not install fallback'));
}
assert.equal(hookSourceCheck({ status: 0, stdout: 'citadel@citadel-local (v1.4.3)' }, 0).pass, true);
assert.equal(hookSourceCheck({ status: 0, stdout: 'citadel@citadel-local (v1.4.3)' }, 39).pass, false);
assert.equal(hookSourceCheck({ status: 0, stdout: '' }, 0).mode, 'unverified');

const root = path.resolve(__dirname, '..');
const adapter = path.join(root, 'hooks_src', 'copilot-adapter.js');

assert.equal(copilot.runtime.id, 'copilot');
assert.equal(typeof copilot.hookInput.normalizeCopilotHookInput, 'function');
assert.equal(typeof copilot.installCopilotHooks, 'function');
assert(copilot.runtime.degradations.includes('hook-timeouts-fail-open'));
assert.equal(isCitadelPluginEnabled('citadel@citadel-local (v1.4.3) (disabled)'), false);
assert.equal(isCitadelPluginEnabled('citadel@citadel-local (v1.4.3)'), true);
assert.equal(isCitadelPluginEnabled('from C:\\work\\Citadel'), false);

const camel = copilot.hookInput.normalizeCopilotHookInput({
  sessionId: 's1',
  transcriptPath: 'C:\\repo\\history.jsonl',
  toolName: 'powershell',
  toolArgs: '{"command":"Get-ChildItem"}',
}, 'preToolUse');
assert.equal(camel.event_id, 'pre_tool');
assert.equal(camel.session_id, 's1');
assert.equal(camel.transcript_path, 'C:\\repo\\history.jsonl');
assert.equal(camel.tool_name, 'Bash');
assert.deepEqual(camel.tool_input, { command: 'Get-ChildItem' });

for (const [event, stdout, expected] of [
  ['sessionStart', 'context', { additionalContext: 'context' }],
  ['preToolUse', JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'blocked', updatedInput: { path: 'safe' },
  } }), { permissionDecision: 'deny', permissionDecisionReason: 'blocked', modifiedArgs: { path: 'safe' } }],
  ['postToolUse', JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PostToolUse', additionalContext: 'check result',
  } }), { additionalContext: 'check result' }],
  ['permissionRequest', JSON.stringify({ hookSpecificOutput: {
    permissionDecision: 'deny', permissionDecisionReason: 'policy',
  } }), { behavior: 'deny', message: 'policy' }],
  ['permissionRequest', JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PermissionRequest', decision: { behavior: 'allow' },
  } }), { behavior: 'allow' }],
  ['agentStop', JSON.stringify({ decision: 'block', reason: 'tests failed' }),
    { decision: 'block', reason: 'tests failed' }],
  ['subagentStop', JSON.stringify({ decision: 'allow', modifiedResponse: 'redacted' }),
    { decision: 'allow', modifiedResponse: 'redacted' }],
  ['subagentStart', 'subagent context', { additionalContext: 'subagent context' }],
  ['postToolUseFailure', 'try a narrower command', { additionalContext: 'try a narrower command' }],
]) {
  assert.deepEqual(translateOutput(event, stdout).output, expected, `${event} output translation`);
  assert.equal(translateOutput(event, '').output, null, `${event} empty output`);
  const malformed = translateOutput(event, '{"bad"');
  assert.equal(malformed.output, null, `${event} malformed output must be suppressed`);
  assert(malformed.diagnostic, `${event} malformed output must become a diagnostic`);
}

assert.equal(
  projectCopilotOutput({
    status: 0,
    nativeEventName: 'sessionStart',
    stdoutParts: ['one', JSON.stringify({ additionalContext: 'two' })],
    stderr: '',
  }).stdout,
  JSON.stringify({ additionalContext: 'one\n\ntwo' }),
);
assert.equal(projectCopilotOutput({
  status: 0,
  nativeEventName: 'userPromptSubmitted',
  stdoutParts: ['discarded command output'],
  stderr: '',
}).stdout, '');
assert.equal(projectCopilotOutput({
  status: 0,
  nativeEventName: 'postToolUseFailure',
  stdoutParts: ['recover with a narrower command'],
  stderr: '',
}).status, 2, 'post-tool failure recovery context must use Copilot exit code 2');

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-copilot-runtime-'));
try {
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1\n');
  const denied = spawnSync(process.execPath, [adapter, 'protect-files', 'preToolUse'], {
    cwd: project,
    input: JSON.stringify({
      sessionId: 's',
      timestamp: Date.now(),
      cwd: project,
      toolName: 'view',
      toolArgs: JSON.stringify({ path: path.join(project, '.env') }),
    }),
    encoding: 'utf8',
  });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /\.env/);

  const allowed = spawnSync(process.execPath, [adapter, 'protect-files', 'preToolUse'], {
    cwd: project,
    input: JSON.stringify({
      sessionId: 's',
      timestamp: Date.now(),
      cwd: project,
      toolName: 'edit',
      toolArgs: { path: path.join(project, 'safe.js') },
    }),
    encoding: 'utf8',
  });
  assert.equal(allowed.status, 0, allowed.stderr);

  assert.equal(dispatchHook('protect-files', 'preToolUse', '{bad').status, 2);
  assert.equal(dispatchHook('protect-files', 'preToolUse', JSON.stringify({
    cwd: project, toolName: 'view', toolArgs: '{bad',
  })).status, 2);
  assert.equal(dispatchHook('post-edit', 'postToolUse', '{bad').status, 0);
  assert.equal(dispatchHook('protect-files', 'preToolUse', JSON.stringify({
    cwd: project, toolName: 'view', toolArgs: { path: 'safe.js' },
  }), {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'crash' }),
  }).status, 2);
  assert.equal(dispatchHook('post-edit', 'postToolUse', JSON.stringify({
    cwd: project, toolName: 'view', toolArgs: { path: 'safe.js' },
  }), {
    spawnSync: () => ({ status: 1, stdout: 'bad output', stderr: 'crash' }),
  }).status, 0);

  let childEnvironment = null;
  dispatchHook('post-edit', 'postToolUse', JSON.stringify({
    sessionId: 's', cwd: project, toolName: 'view', toolArgs: { path: 'safe.js' },
  }), {
    spawnSync: (_executable, _args, options) => {
      childEnvironment = options.env;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(childEnvironment.CITADEL_RUNTIME, 'copilot');
  assert.equal(childEnvironment.CLAUDE_PROJECT_DIR, project);

  const multi = spawnSync(process.execPath, [adapter, 'protect-files', 'preToolUse'], {
    cwd: project,
    input: JSON.stringify({
      sessionId: 's',
      timestamp: Date.now(),
      cwd: project,
      toolName: 'apply_patch',
      toolArgs: {
        command: [
          '*** Begin Patch',
          '*** Update File: safe.js',
          '@@',
          '-old',
          '+new',
          '*** Update File: .env',
          '@@',
          '-SECRET=1',
          '+SECRET=2',
          '*** End Patch',
        ].join('\n'),
      },
    }),
    encoding: 'utf8',
  });
  assert.equal(multi.status, 2, 'every apply_patch target must be evaluated');

  // Copilot 1.0.95+ batches tool calls and passes apply_patch args as raw text.
  const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
  const runBatch = (toolCalls, hook = 'protect-files') => spawnSync(process.execPath, [adapter, hook, 'preToolUse'], {
    cwd: project,
    input: JSON.stringify({ sessionId: 's', timestamp: Date.now(), cwd: project, toolCalls }),
    encoding: 'utf8',
  });
  const call = (id, name, args) => ({ id, name, args });

  const rawSingle = spawnSync(process.execPath, [adapter, 'protect-files', 'preToolUse'], {
    cwd: project,
    input: JSON.stringify({
      cwd: project, toolName: 'apply_patch', toolArgs: patch('*** Add File: hello.txt', '+hello'),
    }),
    encoding: 'utf8',
  });
  assert.equal(rawSingle.status, 0, `single-tool raw apply_patch must be allowed: ${rawSingle.stderr}`);

  for (const [label, body] of [
    ['add', patch(`*** Add File: ${path.join(project, 'hello.txt')}`, '+hello')],
    ['update', patch('*** Update File: safe.js', '@@', '-old', '+new')],
    ['delete', patch('*** Delete File: safe.js')],
  ]) {
    const result = runBatch([call('c1', 'apply_patch', body)]);
    assert.equal(result.status, 0, `batched apply_patch ${label} must be allowed: ${result.stderr}`);
  }
  for (const [label, body] of [
    ['add', patch('*** Add File: .env', '+SECRET=1')],
    ['update', patch('*** Update File: .env', '@@', '-SECRET=1', '+SECRET=2')],
    ['delete', patch('*** Delete File: .env')],
  ]) {
    assert.equal(runBatch([call('c1', 'apply_patch', body)]).status, 2,
      `batched apply_patch ${label} of .env must be denied`);
  }

  const batchedAllowed = runBatch([
    call('c1', 'apply_patch', patch('*** Add File: a.txt', '+a')),
    call('c2', 'edit', { path: path.join(project, 'safe.js') }),
    call('c3', 'view', JSON.stringify({ path: path.join(project, 'safe.js') })),
  ]);
  assert.equal(batchedAllowed.status, 0, `allowed multi-call batch: ${batchedAllowed.stderr}`);
  for (const order of [
    [call('c1', 'edit', { path: path.join(project, 'safe.js') }), call('c2', 'edit', { path: path.join(project, '.env') })],
    [call('c1', 'edit', { path: path.join(project, '.env') }), call('c2', 'edit', { path: path.join(project, 'safe.js') })],
  ]) {
    assert.equal(runBatch(order).status, 2, 'one denied call must deny the whole batch, in any position');
  }

  for (const [label, toolCalls] of [
    ['unknown tool', [call('c1', 'apply_patch', patch('*** Add File: a.txt', '+a')), call('c2', 'mystery', {})]],
    ['unparseable args', [call('c1', 'view', '{bad')]],
    ['patch without boundaries', [call('c1', 'apply_patch', '*** Add File: a.txt\n+a\n')]],
    ['non-object call', [call('c1', 'edit', { path: 'safe.js' }), 'apply_patch']],
    ['empty batch', []],
  ]) {
    assert.equal(runBatch(toolCalls).status, 2, `security hooks must fail closed on ${label}`);
  }
  assert.equal(dispatchHook('protect-files', 'preToolUse', JSON.stringify({
    cwd: project, toolCalls: { id: 'c1', name: 'edit' },
  })).status, 2, 'non-array toolCalls must fail closed');

  const batchEnvelopes = copilot.hookInput.normalizeCopilotHookInputs({
    sessionId: 's2', cwd: project,
    toolCalls: [call('c1', 'apply_patch', patch('*** Add File: a.txt', '+a')), call('c2', 'powershell', '{"command":"ls"}')],
  }, 'preToolUse');
  assert.equal(batchEnvelopes.length, 2);
  assert.equal(batchEnvelopes[0].tool_name, 'apply_patch');
  assert.match(batchEnvelopes[0].tool_input.command, /Add File: a\.txt/);
  assert.equal(batchEnvelopes[1].tool_name, 'Bash');
  assert.deepEqual(batchEnvelopes[1].tool_input, { command: 'ls' });
  assert(batchEnvelopes.every((item) => item.session_id === 's2' && item.cwd === project));
  assert.equal(batchEnvelopes[1].raw.toolCallId, 'c2');
  assert(!('toolCalls' in batchEnvelopes[1].raw), 'per-call raw payloads must not carry the whole batch');

  assert.deepEqual(mergeOutputs([
    { permissionDecision: 'deny', permissionDecisionReason: 'secret' },
    { permissionDecision: 'allow', permissionDecisionReason: 'fine' },
  ]), { permissionDecision: 'deny', permissionDecisionReason: 'secret' }, 'a later allow must not overwrite a deny');
  assert.equal(mergeOutputs([{ decision: 'block', reason: 'x' }, { decision: 'allow' }]).decision, 'block');
  assert.equal(mergeOutputs([{ behavior: 'allow' }, { behavior: 'deny', message: 'no' }]).message, 'no');

  fs.mkdirSync(path.join(project, '.github', 'copilot'), { recursive: true });
  const settingsPath = path.join(project, '.github', 'copilot', 'settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    custom: true,
    version: 1,
    hooks: {
      preToolUse: [{ type: 'command', exec: 'node', args: ['/user/hook.js'] }],
    },
  }));
  const first = installCopilotHooks({ projectRoot: project, citadelRoot: root });
  const firstBytes = fs.readFileSync(settingsPath, 'utf8');
  const second = installCopilotHooks({ projectRoot: project, citadelRoot: root });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), firstBytes, 'reinstall must be byte-idempotent');
  assert(first.settings.custom, 'unrelated settings must survive');
  assert(first.hooks.preToolUse.some((entry) => entry.args?.includes('/user/hook.js')),
    'user hooks must survive');
  assert(first.skipped.length > 0, 'unsupported events must be reported');
  assert(first.hooks.preToolUse.every((entry) => !entry.args?.includes(adapter)
    || entry.env?.CITADEL_RUNTIME === 'copilot'));
  validateCopilotConfig(second.settings);

  // Declaring the Agent Plugins v1 $schema makes Copilot read MCP servers only
  // from mcp.json and agents only from com.github.copilot/agents, and warn about
  // the root .mcp.json and agents/. Keep it out until that layout is adopted.
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  assert(!('$schema' in pluginManifest), 'plugin.json must not declare the Agent Plugins v1 schema yet');
  // Legacy plugins do not discover the Agent Plugins namespaced hooks path.
  assert.equal(pluginManifest.hooks, './com.github.copilot/hooks/hooks.json',
    'legacy plugin manifest must explicitly load the generated Copilot hooks');
  validateCopilotConfig(JSON.parse(fs.readFileSync(path.resolve(root, pluginManifest.hooks), 'utf8')));

  const pluginHooks = writeCopilotPluginHooks({ citadelRoot: root, check: true });
  assert.equal(pluginHooks.changed, false, 'native plugin hooks must match the generator');
  assert(pluginHooks.content.includes(PLUGIN_ADAPTER));
  assert(!pluginHooks.content.includes(root), 'native plugin hooks must not contain checkout paths');

  const projection = proposeCopilotProjection({ target: project, source: root });
  assert.equal(projection.runtime, 'copilot');
  assert.equal(projection.status, 'project_local_hooks');
  assert.equal(projection.proposed_effects[0].path, '.github/copilot/settings.local.json');
  assert.equal(projection.proposed_effects[0].ownership, 'owned');
  assert.equal(projection.proposed_effects[0].removal.strategy, 'restore_preimage_if_exact');

  const beforeRemoval = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const citadelCount = countCitadelHooks(beforeRemoval.hooks);
  assert(citadelCount > 0);
  const removal = removeCopilotHooks({ projectRoot: project });
  assert.equal(removal.removed, citadelCount);
  const migrated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert(migrated.custom);
  assert(migrated.hooks.preToolUse.some((entry) => entry.args?.includes('/user/hook.js')));
  assert.equal(countCitadelHooks(migrated.hooks), 0);
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}

console.log('copilot runtime tests passed');
