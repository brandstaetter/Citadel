'use strict';

const {
  quoteNodeCommand,
  writeJson,
} = require('../../../core/hooks/install');
const fs = require('fs');
const { inspectCodexHookOwnership, assertUnambiguous } = require('./hook-ownership');
const { filterHookTemplate } = require('../../../core/hooks/bundles');
const {
  classifyOutputs,
  ensureMachineLocalExcludes,
  inspectInstallInventory,
} = require('../../../core/runtime/install-contract');

const CODEX_EVENTS = new Set([
  'SessionStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
]);

const EVENT_MAP = {
  SessionStart: 'SessionStart',
  PreToolUse: 'PreToolUse',
  PermissionRequest: 'PermissionRequest',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: null,
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  UserPromptSubmit: 'UserPromptSubmit',
  Stop: 'Stop',
  StopFailure: null,
  SessionEnd: 'SessionEnd',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  TaskCreated: null,
  TaskCompleted: null,
  WorktreeCreate: null,
  WorktreeRemove: null,
};

const CODEX_MATCHER_ALIASES = Object.freeze({
  Edit: ['apply_patch'],
  Write: ['apply_patch'],
});

function extractHookName(command) {
  const match = command.match(/hooks_src\/([^.]+)\.js/);
  return match ? match[1] : null;
}

function translateCodexHooks(hooksTemplate, adapterScriptPath, options = {}) {
  const bundleFilter = filterHookTemplate(hooksTemplate, options.effectiveBundles);
  hooksTemplate = bundleFilter.template;
  const codexHooks = {};
  const warnings = [];
  const installed = [];
  const skipped = [];
  const entrySignatures = new Set();
  const adapterPath = adapterScriptPath.replace(/\\/g, '/');
  const adapterCmd = quoteNodeCommand(`node ${adapterPath}`);
  const commandForHook = options.commandForHook || ((hookName) => `${adapterCmd} ${hookName}`);
  const commandWindowsForHook = options.commandWindowsForHook || null;

  for (const [citadelEvent, entries] of Object.entries(hooksTemplate.hooks || {})) {
    const codexEvent = EVENT_MAP[citadelEvent];

    if (!codexEvent) {
      for (const entry of entries) {
        for (const hook of entry.hooks || []) {
          const name = extractHookName(hook.command);
          if (name) skipped.push({ hook: name, event: citadelEvent, reason: 'no Codex equivalent' });
        }
      }
      warnings.push(`${citadelEvent}: no Codex equivalent (${entries.length} hook(s) skipped)`);
      continue;
    }

    if (!codexHooks[codexEvent]) codexHooks[codexEvent] = [];

    for (const entry of entries) {
      if (!entry.hooks) continue;

      const hooks = [];
      for (const hook of entry.hooks) {
        const hookName = extractHookName(hook.command);
        if (!hookName) continue;
        const translatedHook = {
          type: 'command',
          command: commandForHook(hookName),
          statusMessage: `Citadel: ${hookName}`,
          timeout: codexEvent === 'SessionEnd'
            ? Math.min(hook.timeout || 30, 3)
            : hook.timeout || 30,
        };
        if (commandWindowsForHook) translatedHook.commandWindows = commandWindowsForHook(hookName);
        hooks.push(translatedHook);
        installed.push({ hook: hookName, event: codexEvent });
      }

      if (hooks.length === 0) continue;

      // Expand pipe-delimited matchers into separate entries (e.g. "Edit|Write" → two entries)
      const sourceMatchers = entry.matcher ? entry.matcher.split('|').map((m) => m.trim()).filter(Boolean) : [null];
      const matchers = sourceMatchers.flatMap((matcher) => CODEX_MATCHER_ALIASES[matcher] || [matcher]);
      for (const matcher of matchers) {
        const signature = JSON.stringify([
          codexEvent,
          matcher,
          hooks.map((hook) => [hook.command, hook.commandWindows || null]),
        ]);
        if (entrySignatures.has(signature)) continue;
        entrySignatures.add(signature);
        const codexEntry = { hooks };
        if (matcher) codexEntry.matcher = matcher;
        codexHooks[codexEvent].push(codexEntry);
      }
    }
  }

  return { hooks: codexHooks, installed, skipped: [...skipped, ...bundleFilter.skipped], warnings, bundleFilter };
}

function translateCodexPluginHooks(hooksTemplate) {
  return translateCodexHooks(hooksTemplate, '${PLUGIN_ROOT}/hooks_src/codex-adapter.js', {
    commandForHook: (hookName) => `node "\${PLUGIN_ROOT}/hooks_src/codex-adapter.js" ${hookName}`,
    // Codex can run Windows hooks in PowerShell or cmd.exe. Resolve the path
    // in Node so neither shell has to expand an environment variable.
    // PowerShell also collapses native exit 2 to 1; use the equivalent native
    // Codex JSON denial for security blocks in this Windows entry point.
    commandWindowsForHook: (hookName) => `node -e "require(require('path').join(process.env.PLUGIN_ROOT,'hooks_src','codex-adapter.js')).main(process.argv[1],{structuredSecurityBlocks:true})" ${hookName}`,
  });
}

function preserveUserHookHandlers(existingHooks, options) {
  const ownership = inspectCodexHookOwnership(existingHooks, options);
  assertUnambiguous(ownership);
  return ownership.preserved;
}

function installCodexHooks(options = {}) {
  const projectRoot = options.projectRoot
    ? require('path').resolve(options.projectRoot)
    : options.outputPath
      ? require('path').resolve(options.outputPath, '..', '..')
      : process.cwd();
  const existingConfig = options.outputPath && fs.existsSync(options.outputPath)
    ? JSON.parse(fs.readFileSync(options.outputPath, 'utf8')) : {};
  const ownership = inspectCodexHookOwnership(options.existingHooks || existingConfig.hooks || {}, options);
  assertUnambiguous(ownership);
  const inventory = inspectInstallInventory(projectRoot, { runtime: 'codex' });
  const machineLocalExcludes = ensureMachineLocalExcludes(projectRoot, {
    dryRun: options.dryRun === true,
  });
  const existingHooks = ownership.preserved;
  const translated = translateCodexHooks(options.hooksTemplate, options.adapterScriptPath, {
    effectiveBundles: options.effectiveBundles,
  });
  // Ownership was decided per handler. Do not apply the old substring filter
  // again: it would discard user commands or entire mixed entries.
  const filteredHooks = { ...existingHooks };
  for (const [event, entries] of Object.entries(translated.hooks)) {
    filteredHooks[event] = [...entries, ...(existingHooks[event] || [])];
  }

  if (options.outputPath && !options.dryRun) {
    writeJson(options.outputPath, { ...existingConfig, hooks: filteredHooks });
  }

  return {
    ...translated,
    hooks: filteredHooks,
    ownership,
    inventory,
    diagnostics: inventory.diagnostics,
    machineLocalExcludes,
    outputs: classifyOutputs(options.outputPath ? [{
      path: '.codex/hooks.json',
      runtime: 'codex',
      ownership: 'machine-local',
      reason: 'Legacy project hook registration contains checkout-local runtime commands.',
    }] : []),
  };
}

module.exports = {
  CODEX_MATCHER_ALIASES,
  CODEX_EVENTS,
  EVENT_MAP,
  extractHookName,
  installCodexHooks,
  preserveUserHookHandlers,
  translateCodexPluginHooks,
  translateCodexHooks,
};
