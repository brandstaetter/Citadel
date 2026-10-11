'use strict';

const fs = require('fs');
const path = require('path');
const { filterHookTemplate } = require('../../../core/hooks/bundles');
const { readJson, writeJson } = require('../../../core/hooks/install');
const {
  classifyOutputs,
  ensureMachineLocalExcludes,
  inspectInstallInventory,
} = require('../../../core/runtime/install-contract');
const { extractHookName } = require('../../codex/generators/install-hooks');

const COPILOT_EVENTS = new Set([
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'permissionRequest',
  'agentStop',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'notification',
]);

const EVENT_MAP = Object.freeze({
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'userPromptSubmitted',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  PermissionRequest: 'permissionRequest',
  Stop: 'agentStop',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  PreCompact: 'preCompact',
  Notification: 'notification',
});

const MATCHER_ALIASES = Object.freeze({
  Bash: ['bash', 'powershell'],
  Read: ['view'],
  Write: ['create', 'apply_patch'],
  Edit: ['edit', 'str_replace_editor', 'apply_patch'],
  Agent: ['task'],
  Grep: ['grep', 'rg'],
  Glob: ['glob'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  TodoWrite: ['update_todo'],
});

function validateCopilotConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Copilot hook config must be an object');
  }
  if (config.version !== 1) throw new Error('Copilot hook config version must be 1');
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    throw new Error('Copilot hook config hooks must be an object');
  }
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!COPILOT_EVENTS.has(event)) throw new Error(`Unsupported Copilot hook event: ${event}`);
    if (!Array.isArray(entries)) throw new Error(`Copilot hook event ${event} must be an array`);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Copilot hook event ${event} contains a non-object entry`);
      }
      if (entry.type !== 'command') throw new Error(`Copilot hook event ${event} must use command hooks`);
      const hasExec = typeof entry.exec === 'string' && (!('args' in entry) || Array.isArray(entry.args));
      const hasShell = ['bash', 'powershell', 'command']
        .some((field) => typeof entry[field] === 'string' && entry[field].trim());
      if (!hasExec && !hasShell) {
        throw new Error(`Copilot hook event ${event} must define exec or a shell command`);
      }
    }
  }
  return true;
}

function sourceMatchers(matcher) {
  if (!matcher) return [null];
  return matcher.split('|').map((item) => item.trim()).filter(Boolean);
}

function copilotMatchers(matcher) {
  const mapped = sourceMatchers(matcher).flatMap((item) => MATCHER_ALIASES[item] || [item]);
  const unique = [...new Set(mapped)];
  return unique.length ? unique : [null];
}

function isCitadelEntry(entry, marker = 'copilot-adapter') {
  const values = [
    entry?.exec,
    ...(Array.isArray(entry?.args) ? entry.args : []),
    entry?.bash,
    entry?.powershell,
    entry?.command,
  ];
  return values.some((value) => typeof value === 'string' && value.includes(marker));
}

function preserveUserHooks(existingHooks, marker = 'copilot-adapter') {
  return Object.fromEntries(Object.entries(existingHooks || {}).flatMap(([event, entries]) => {
    if (!Array.isArray(entries)) return [[event, entries]];
    const preserved = entries.filter((entry) => !isCitadelEntry(entry, marker));
    return preserved.length ? [[event, preserved]] : [];
  }));
}

function countCitadelHooks(hooks, marker = 'copilot-adapter') {
  return Object.values(hooks || {}).reduce((count, entries) => (
    count + (Array.isArray(entries) ? entries.filter((entry) => isCitadelEntry(entry, marker)).length : 0)
  ), 0);
}

function removeCopilotHooks(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputPath = path.resolve(
    options.outputPath || path.join(projectRoot, '.github', 'copilot', 'settings.local.json'),
  );
  const existing = readJson(outputPath, null, { strict: true });
  if (!existing) return { changed: false, removed: 0, deleted: false, outputPath, settings: null };
  const removed = countCitadelHooks(existing.hooks || {});
  if (removed === 0) return { changed: false, removed: 0, deleted: false, outputPath, settings: existing };

  const hooks = preserveUserHooks(existing.hooks || {});
  const settings = { ...existing, hooks };
  const removableKeys = Object.keys(settings).filter((key) => key !== 'version' && key !== 'hooks');
  const deleted = removableKeys.length === 0 && Object.keys(hooks).length === 0;
  if (!options.dryRun) {
    if (deleted) fs.unlinkSync(outputPath);
    else writeJson(outputPath, settings, { validate: validateCopilotConfig });
  }
  return { changed: true, removed, deleted, outputPath, settings: deleted ? null : settings };
}

function translateCopilotHooks(hooksTemplate, adapterScriptPath, options = {}) {
  const filtered = filterHookTemplate(hooksTemplate, options.effectiveBundles);
  const hooks = {};
  const installed = [];
  const skipped = [];
  const warnings = [];
  const signatures = new Set();
  const adapterPath = /\$\{(?:COPILOT_)?PLUGIN_ROOT\}/.test(adapterScriptPath)
    ? adapterScriptPath.replace(/\\/g, '/')
    : path.resolve(adapterScriptPath);

  for (const [citadelEvent, groups] of Object.entries(filtered.template.hooks || {})) {
    const event = EVENT_MAP[citadelEvent];
    if (!event) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          const hookName = extractHookName(hook.command || '');
          if (hookName) skipped.push({ hook: hookName, event: citadelEvent, reason: 'no Copilot equivalent' });
        }
      }
      warnings.push(`${citadelEvent}: no Copilot equivalent (${groups.length} hook group(s) skipped)`);
      continue;
    }

    if (!hooks[event]) hooks[event] = [];
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        const hookName = extractHookName(hook.command || '');
        if (!hookName) continue;
        for (const matcher of copilotMatchers(group.matcher)) {
          const entry = {
            type: 'command',
            exec: 'node',
            args: [adapterPath, hookName, event],
            env: { CITADEL_RUNTIME: 'copilot' },
            timeoutSec: hook.timeout || 30,
          };
          if (matcher) entry.matcher = matcher;
          const signature = JSON.stringify(entry);
          if (signatures.has(signature)) continue;
          signatures.add(signature);
          hooks[event].push(entry);
          installed.push({ hook: hookName, event, matcher });
        }
      }
    }
  }

  return {
    hooks,
    installed,
    skipped: [...skipped, ...filtered.skipped],
    warnings,
    bundleFilter: filtered,
  };
}

function installCopilotHooks(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const citadelRoot = path.resolve(options.citadelRoot || path.join(__dirname, '..', '..', '..'));
  const outputPath = path.resolve(
    options.outputPath || path.join(projectRoot, '.github', 'copilot', 'settings.local.json'),
  );
  const template = options.hooksTemplate || JSON.parse(
    fs.readFileSync(path.join(citadelRoot, 'hooks', 'hooks-template.json'), 'utf8'),
  );
  const adapterScriptPath = options.adapterScriptPath
    || path.join(citadelRoot, 'hooks_src', 'copilot-adapter.js');
  const existing = options.existing || readJson(outputPath, {}, { strict: true });
  const translated = translateCopilotHooks(template, adapterScriptPath, {
    effectiveBundles: options.effectiveBundles,
  });
  const preserved = preserveUserHooks(existing.hooks || {});
  const hooks = { ...preserved };
  for (const [event, entries] of Object.entries(translated.hooks)) {
    hooks[event] = [...entries, ...(preserved[event] || [])];
  }
  const settings = { ...existing, version: 1, hooks };

  const inventory = inspectInstallInventory(projectRoot, { runtime: 'copilot' });
  const machineLocalExcludes = ensureMachineLocalExcludes(projectRoot, {
    dryRun: options.dryRun === true,
  });
  if (!options.dryRun) writeJson(outputPath, settings, { validate: validateCopilotConfig });

  return {
    ...translated,
    settings,
    settingsPath: outputPath,
    hooks,
    inventory,
    diagnostics: inventory.diagnostics,
    machineLocalExcludes,
    outputs: classifyOutputs([{
      path: '.github/copilot/settings.local.json',
      runtime: 'copilot',
      ownership: 'machine-local',
      reason: 'Resolved Copilot CLI hook commands contain checkout-local paths.',
    }]),
  };
}

module.exports = Object.freeze({
  COPILOT_EVENTS,
  EVENT_MAP,
  MATCHER_ALIASES,
  copilotMatchers,
  countCitadelHooks,
  installCopilotHooks,
  isCitadelEntry,
  preserveUserHooks,
  removeCopilotHooks,
  translateCopilotHooks,
  validateCopilotConfig,
});
