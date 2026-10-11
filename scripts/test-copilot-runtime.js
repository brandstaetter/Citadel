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
