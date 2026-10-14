#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { inspectCodexHookOwnership, assertNoPluginHooks } = require('../runtimes/codex/generators/hook-ownership');

const { installClaudeHooks } = require('../runtimes/claude-code/generators/install-hooks');
const { installCodexHooks, translateCodexHooks, translateCodexPluginHooks } = require('../runtimes/codex/generators/install-hooks');
const { installCopilotHooks, translateCopilotHooks } = require('../runtimes/copilot/generators/install-hooks');
const { generateCopilotPluginHooks, PLUGIN_ADAPTER } = require('../runtimes/copilot/generators/plugin');
const { claudeShellContainmentReadiness } = require('../core/security/shell-containment');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-hook-install-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const citadelRoot = path.resolve(__dirname, '..');
const hooksTemplatePath = path.join(citadelRoot, 'hooks', 'hooks-template.json');
const hooksTemplate = JSON.parse(fs.readFileSync(hooksTemplatePath, 'utf8'));

const nativeWindowsBoundary = claudeShellContainmentReadiness({ platform: 'win32', env: {} });
assert.equal(nativeWindowsBoundary.status, 'unsupported-host');
assert.match(nativeWindowsBoundary.message, /not contained by Citadel/);
assert.match(nativeWindowsBoundary.message, /WSL2/);

const wslBoundary = claudeShellContainmentReadiness({
  platform: 'linux',
  env: { WSL_DISTRO_NAME: 'Ubuntu' },
});
assert.equal(wslBoundary.status, 'runtime-unverified');
assert.match(wslBoundary.message, /does not verify/);

function countHookHandlers(hooks) {
  return Object.values(hooks || {}).reduce((total, entries) => total + entries.reduce(
    (entryTotal, entry) => entryTotal + (entry.hooks || []).length,
    0
  ), 0);
}


withTempDir((projectRoot) => {
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Read'] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [{ type: 'command', command: 'node "/custom/user-hook.js"' }],
        },
      ],
    },
  }, null, 2));

  const result = installClaudeHooks({ citadelRoot, hooksTemplatePath, projectRoot, hookProfile: 'latest' });
  const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));

  assert(settings.hooks.PreToolUse.length >= 2, 'claude install should merge generated and user hooks');
  assert.equal(settings.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1', 'claude install should inject subprocess scrub env');
  assert.equal(settings.permissions.allow[0], 'Read', 'claude install should preserve non-hook settings');
  assert.equal(result.compatibility.hookProfile, 'latest', 'latest profile should be reported');
  const firstInstallCount = countHookHandlers(settings.hooks);
  installClaudeHooks({ citadelRoot, hooksTemplatePath, projectRoot, hookProfile: 'latest' });
  const reinstalled = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
  assert.equal(countHookHandlers(reinstalled.hooks), firstInstallCount,
    'claude hook reinstall should be idempotent and must not duplicate generated hooks');
  assert.deepEqual(reinstalled.hooks, settings.hooks,
    'claude hook reinstall should preserve the exact merged hook registration set');

});

const copilotTranslated = translateCopilotHooks(hooksTemplate, '/tmp/copilot-adapter.js');
assert(copilotTranslated.installed.length > 0);
assert(copilotTranslated.skipped.length > 0);
assert.deepEqual(Object.keys(copilotTranslated.hooks).sort(), [
  'agentStop',
  'notification',
  'permissionRequest',
  'postToolUse',
  'postToolUseFailure',
  'preCompact',
  'preToolUse',
  'sessionEnd',
  'sessionStart',
  'subagentStart',
  'subagentStop',
  'userPromptSubmitted',
]);
assert(copilotTranslated.hooks.preToolUse.some((entry) =>
  entry.matcher === 'view' && entry.args.includes('protect-files')));
assert(copilotTranslated.hooks.preToolUse.some((entry) =>
  entry.matcher === 'apply_patch' && entry.args.includes('protect-files')));
assert(copilotTranslated.hooks.preToolUse.every((entry) =>
  entry.exec === 'node' && entry.env.CITADEL_RUNTIME === 'copilot'));
const copilotPlugin = generateCopilotPluginHooks({ citadelRoot });
assert(copilotPlugin.config.hooks.preToolUse.every((entry) =>
  entry.args.includes(PLUGIN_ADAPTER)));

withTempDir((projectRoot) => {
  const outputPath = path.join(projectRoot, '.github', 'copilot', 'settings.local.json');
  const first = installCopilotHooks({
    projectRoot,
    citadelRoot,
    existing: {
      version: 1,
      customSetting: true,
      hooks: {
        preToolUse: [{ type: 'command', exec: 'node', args: ['/custom/hook.js'] }],
      },
    },
  });
  const initial = fs.readFileSync(outputPath, 'utf8');
  installCopilotHooks({ projectRoot, citadelRoot });
  assert.equal(fs.readFileSync(outputPath, 'utf8'), initial);
  assert(first.settings.customSetting);
  assert(first.hooks.preToolUse.some((entry) => entry.args.includes('/custom/hook.js')));
});

withTempDir((projectRoot) => {
  const result = installClaudeHooks({
    citadelRoot,
    hooksTemplatePath,
    projectRoot,
    hookProfile: 'auto',
    claudeVersion: '2.1.75',
  });
  const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));

  assert(settings.hooks.SessionStart, 'legacy-compatible install should keep SessionStart');
  assert(settings.hooks.SessionEnd, 'legacy-compatible install should keep SessionEnd');
  assert(!settings.hooks.PostCompact, 'legacy-compatible install should omit PostCompact before 2.1.76');
  assert(!settings.hooks.StopFailure, 'legacy-compatible install should omit StopFailure before 2.1.78');
  assert(!settings.hooks.TaskCreated, 'legacy-compatible install should omit TaskCreated before 2.1.84');
  assert(!settings.hooks.WorktreeCreate, 'legacy-compatible install should omit WorktreeCreate before 2.1.84');
  assert(result.compatibility.skippedEvents.includes('PostCompact'), 'legacy-compatible install should report skipped events');
});

const translated = translateCodexHooks(hooksTemplate, '/tmp/codex-adapter.js');
assert(translated.installed.length > 0, 'codex translation should install mapped hooks');
assert(translated.skipped.length > 0, 'codex translation should record unmapped hooks');
assert.deepEqual(Object.keys(translated.hooks).sort(), [
  'PermissionRequest',
  'PostCompact',
  'PostToolUse',
  'PreCompact',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
], 'Codex translation should project the exact native 11-event set');
const applyPatchProtectEntries = translated.hooks.PreToolUse.filter((entry) =>
  entry.matcher === 'apply_patch'
  && entry.hooks.some((hook) => hook.command.includes('protect-files'))
);
assert.equal(applyPatchProtectEntries.length, 1,
  'codex translation should register one protect-files projection for apply_patch');
assert(!translated.hooks.PreToolUse.some((entry) =>
  (entry.matcher === 'Edit' || entry.matcher === 'Write')
  && entry.hooks.some((hook) => hook.command.includes('protect-files'))
), 'codex translation should canonicalize Edit/Write matcher aliases to apply_patch');
const bashGateEntries = translated.hooks.PreToolUse.filter((entry) =>
  entry.matcher === 'Bash'
  && entry.hooks.some((hook) => hook.command.includes('external-action-gate'))
);
assert.equal(bashGateEntries.length, 1,
  'codex translation should register one canonical Bash external-action gate');
assert(!translated.hooks.PreToolUse.some((entry) => entry.matcher === 'Edit|Write'), 'codex translation should not leave pipe-delimited matchers');
assert(translated.hooks.PermissionRequest, 'codex translation should install PermissionRequest hooks');
assert(translated.hooks.PreCompact, 'codex translation should install PreCompact hooks');
assert(translated.hooks.PostCompact, 'codex translation should install PostCompact hooks');
assert(translated.hooks.UserPromptSubmit?.some((entry) =>
  entry.hooks.some((hook) => hook.command.includes('user-prompt-submit'))
), 'codex translation should install the native UserPromptSubmit hook');
assert(translated.hooks.SubagentStart, 'codex translation should install SubagentStart hooks');
assert(translated.hooks.SubagentStop, 'codex translation should install SubagentStop hooks');
assert(translated.hooks.SessionEnd?.some((entry) =>
  entry.hooks.some((hook) => hook.command.includes('session-end'))
), 'codex translation should install session-end on native SessionEnd');
assert(translated.hooks.SessionEnd.every((entry) =>
  entry.hooks.every((hook) => hook.timeout <= 3)
), 'Codex SessionEnd hooks must stay within the native three-second limit');
assert(!translated.hooks.Stop.some((entry) =>
  entry.hooks.some((hook) => hook.command.includes('session-end'))
), 'codex translation must not project SessionEnd handlers onto Stop');

const pluginHooks = translateCodexPluginHooks(hooksTemplate);
const pluginPermissionHook = pluginHooks.hooks.PermissionRequest[0].hooks[0];
assert(pluginPermissionHook.command.includes('${PLUGIN_ROOT}'), 'plugin hooks should use PLUGIN_ROOT in POSIX command');
assert(pluginPermissionHook.commandWindows.includes('process.env.PLUGIN_ROOT'), 'plugin hooks should use PLUGIN_ROOT in Windows command');
const checkedInPluginHooks = JSON.parse(fs.readFileSync(
  path.join(citadelRoot, 'runtimes', 'codex', 'hooks.json'),
  'utf8'
));
assert.deepEqual(checkedInPluginHooks, { hooks: pluginHooks.hooks },
  'checked-in Codex hooks must exactly match the current generator projection');

withTempDir((projectRoot) => {
  const outputPath = path.join(projectRoot, '.codex', 'hooks.json');
  const result = installCodexHooks({
    hooksTemplate,
    adapterScriptPath: '/tmp/codex-adapter.js',
    existingHooks: {
      PreToolUse: [
        {
          hooks: [{ type: 'command', command: 'node "/custom/user-hook.js"' }],
        },
      ],
    },
    outputPath,
  });

  const hooks = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert(result.hooks.PreToolUse.length >= 2, 'codex install should merge generated and user hooks');
  assert(hooks.hooks.PreToolUse.length >= 2, 'codex install should persist merged hooks');
});

withTempDir((projectRoot) => {
  const staleSessionEnd = {
    hooks: [
      {
        type: 'command',
        command: `node "${citadelRoot.replace(/\\/g, '/')}/hooks_src/codex-adapter.js" session-end`,
      },
      {
        type: 'command',
        command: 'node "/custom/co-located-stop.js"',
      },
    ],
  };
  const userStopHook = {
    hooks: [{
      type: 'command',
      command: 'node "/custom/user-stop.js"',
    }],
  };
  const result = installCodexHooks({
    hooksTemplate,
    adapterScriptPath: '/tmp/codex-adapter.js',
    existingHooks: { Stop: [staleSessionEnd, userStopHook] },
  });

  assert(!result.hooks.Stop.some((entry) =>
    entry.hooks.some((hook) => hook.command.includes('session-end'))
  ), 'Codex reinstall should remove the stale generated session-end handler from Stop');
  assert(result.hooks.Stop.some((entry) =>
    entry.hooks.some((hook) => hook.command.includes('/custom/user-stop.js'))
  ), 'Codex reinstall should preserve unrelated user Stop hooks');
  assert(result.hooks.Stop.some((entry) =>
    entry.hooks.some((hook) => hook.command.includes('/custom/co-located-stop.js'))
  ), 'Codex reinstall should preserve a user hook co-located with a stale generated handler');
  assert(result.hooks.SessionEnd.some((entry) =>
    entry.hooks.some((hook) => hook.command.includes('session-end'))
  ), 'Codex reinstall should place the generated session-end handler on SessionEnd');
});

withTempDir((projectRoot) => {
  const legacy = JSON.parse(JSON.stringify(hooksTemplate.hooks).replaceAll('${CLAUDE_PLUGIN_ROOT}', citadelRoot.replace(/\\/g, '/')));
  const userHook = { type: 'command', command: 'node user-check.js', timeout: 17 };
  legacy.PreToolUse[0].hooks.push(userHook);
  const options = { projectRoot, hooksTemplate, adapterScriptPath: path.join(citadelRoot, 'hooks_src', 'codex-adapter.js') };
  const migrated = installCodexHooks({ ...options, existingHooks: legacy });
  assert(!JSON.stringify(migrated.hooks).includes('/hooks_src/protect-files.js'), 'direct legacy handlers must be replaced');
  assert(migrated.hooks.PreToolUse.some((entry) => entry.matcher === 'Edit|Write' && entry.hooks.includes(userHook)));
  assert.deepStrictEqual(installCodexHooks({ ...options, existingHooks: migrated.hooks }).hooks, migrated.hooks,
    'repeat installation must not duplicate handlers');
});

console.log('hook installer tests passed');

withTempDir((projectRoot) => {
  const adapterScriptPath = path.join(citadelRoot, 'hooks_src', 'codex-adapter.js');
  const options = { projectRoot, hooksTemplate, adapterScriptPath };
  const direct = JSON.parse(JSON.stringify(hooksTemplate.hooks.PreToolUse[2]).replaceAll('${CLAUDE_PLUGIN_ROOT}', citadelRoot.replace(/\\/g, '/')));
  const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node user.js' }] };
  const windows = structuredClone(direct);
  windows.hooks[0].command = `node "${citadelRoot}\\hooks_src\\external-action-gate.js"`;
  assert.equal(inspectCodexHookOwnership({ PreToolUse: [windows] }, options).owned.length, 1);
  for (const modify of [
    (entry) => { entry.hooks[0].timeout = 999; },
    (entry) => { entry.matcher = 'custom'; },
    (entry) => { entry.hooks[0].command += ' && node user.js'; },
    (entry) => { entry.hooks[0].commandWindows = 'node user-windows.js'; },
    (entry) => { entry.hooks[0].command = 'node C:/unverified/hooks_src/external-action-gate.js'; },
    (entry) => { entry.hooks[0].command = 'node C:/unverified/codex-adapter.js external-action-gate'; },
  ]) {
    const modified = structuredClone(direct);
    modify(modified);
    const before = JSON.stringify(modified);
    const inspected = inspectCodexHookOwnership({ PreToolUse: [modified, user] }, options);
    assert.equal(inspected.ambiguous.length, 1);
    assert.deepEqual(inspected.preserved.PreToolUse, [modified, user]);
    assert.throws(() => installCodexHooks({ ...options, existingHooks: { PreToolUse: [modified, user] } }),
      { code: 'CODEX_HOOK_OWNERSHIP_AMBIGUOUS' });
    assert.equal(JSON.stringify(modified), before);
  }
  const outputPath = path.join(projectRoot, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const original = JSON.stringify({ custom: 'keep', hooks: { PreToolUse: [direct, user] } });
  fs.writeFileSync(outputPath, original);
  const env = { ...process.env, CODEX_HOME: path.join(projectRoot, 'codex-home') };
  const cli = (args) => spawnSync(process.execPath, [path.join(citadelRoot, 'scripts/install-hooks-codex.js'), projectRoot, '--json', ...args],
    { env, encoding: 'utf8' });
  const preview = cli(['--dry-run']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
  assert(!fs.existsSync(`${outputPath}.pre-citadel-migration`));
  assert(!fs.existsSync(path.join(projectRoot, '.citadel')));
  for (const existing of [{ PreToolUse: [direct] }, translateCodexHooks(hooksTemplate, adapterScriptPath).hooks]) {
    fs.writeFileSync(outputPath, JSON.stringify({ hooks: existing }));
    const preflight = spawnSync(process.execPath, [path.join(citadelRoot, 'scripts/codex-install.js'),
      '--project-root', projectRoot, '--install', '--dry-run', '--json'], { env, encoding: 'utf8' });
    assert.equal(preflight.status, 2, preflight.stderr);
    assert(JSON.parse(preflight.stdout).blockers.includes('.codex/hooks.json'));
    assert.equal(JSON.parse(preflight.stdout).steps.length, 0);
  }
  fs.writeFileSync(outputPath, original);
  const applied = cli([]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(fs.readFileSync(`${outputPath}.pre-citadel-migration`, 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).custom, 'keep');
  const once = fs.readFileSync(outputPath, 'utf8');
  assert.equal(cli([]).status, 0);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), once);
  assert.equal(cli(['--remove-local']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')).hooks, { PreToolUse: [user] });
  assert.equal(cli(['--remove-local']).status, 0);
  const configPath = path.join(projectRoot, '.codex', 'config.toml');
  fs.writeFileSync(configPath, '[plugins."citadel@citadel-local"]\nenabled = true\n');
  assert.throws(() => assertNoPluginHooks(projectRoot, { env }), { code: 'CODEX_PLUGIN_HOOK_CONFLICT' });
  assert.equal(JSON.parse(cli([]).stdout).code, 'CODEX_PLUGIN_HOOK_CONFLICT');
  assert.equal(cli(['--remove-local', '--dry-run']).status, 0);
  fs.writeFileSync(configPath, '[plugins."citadel@citadel-local"]\nenabled = false\n');
  assert.doesNotThrow(() => assertNoPluginHooks(projectRoot, { env }));
});

console.log('Codex legacy ownership, migration, plugin conflicts and idempotence passed');
