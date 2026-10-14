'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

function normalizedPath(value) {
  const normalized = String(value).replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

// Shell wrappers, extra arguments and lookalike filenames require review.
function invocation(command) {
  const match = /^node\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+([a-z][a-z0-9-]*))?$/.exec(command || '');
  if (!match) return null;
  const script = (match[1] || match[2] || match[3]).replace(/\\/g, '/');
  const direct = /^(.*)\/hooks_src\/([a-z][a-z0-9-]*)\.js$/.exec(script);
  const adapter = /(?:^|\/)codex-adapter\.js$/.test(script);
  if (adapter && match[4]) return { script, name: match[4], adapter: true, root: direct?.[1] };
  if (direct && !match[4]) return { script, name: direct[2], adapter: false, root: direct[1] };
  return null;
}

function inspectCodexHookOwnership(existingHooks, options) {
  const preserved = {};
  const owned = [];
  const ambiguous = [];
  const trusted = new Map();
  function trustedScript(call) {
    if (call.adapter && normalizedPath(call.script) === normalizedPath(options.adapterScriptPath)) return true;
    if (!call.root) return false;
    const root = normalizedPath(call.root);
    const installerRoot = normalizedPath(path.resolve(options.adapterScriptPath, '..', '..'));
    if (root === installerRoot) return true;
    if (!trusted.has(root)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(call.root, 'plugin.json'), 'utf8'));
        trusted.set(root, manifest.name === 'citadel'
          && fs.existsSync(path.join(call.root, 'hooks', 'hooks-template.json'))
          && fs.existsSync(path.join(call.root, 'hooks_src', 'codex-adapter.js')));
      } catch { trusted.set(root, false); }
    }
    return trusted.get(root);
  }
  function generatedShape(event, entry, hook, call) {
    if (Object.keys(entry).some((key) => !['matcher', 'hooks'].includes(key))) return false;
    for (const [sourceEvent, entries] of Object.entries(options.hooksTemplate.hooks || {})) {
      if (event !== sourceEvent && !(call.adapter && event === 'Stop' && sourceEvent === 'SessionEnd')) continue;
      for (const source of entries) {
        const matchers = call.adapter
          ? (source.matcher ? source.matcher.split('|').flatMap((m) => ['Edit', 'Write'].includes(m) ? [m, 'apply_patch'] : [m]) : [undefined])
          : [source.matcher];
        if (!matchers.includes(entry.matcher)) continue;
        for (const original of source.hooks || []) {
          if (invocation(original.command)?.name !== call.name) continue;
          const expected = call.adapter
            ? { type: 'command', command: hook.command, statusMessage: `Citadel: ${call.name}`,
                timeout: event === 'SessionEnd' ? Math.min(original.timeout || 30, 3) : original.timeout || 30 }
            : { ...original, command: hook.command };
          if (isDeepStrictEqual(hook, expected)) return true;
          // Older projections omitted statusMessage and sometimes timeout.
          if (call.adapter) {
            delete expected.statusMessage;
            if (isDeepStrictEqual(hook, expected)) return true;
            delete expected.timeout;
            if (isDeepStrictEqual(hook, expected)) return true;
          }
        }
      }
    }
    return false;
  }
  for (const [event, entries] of Object.entries(existingHooks || {})) {
    if (!Array.isArray(entries)) throw new Error(`Invalid hook entries for ${event}`);
    const kept = [];
    entries.forEach((entry, entryIndex) => {
      const hooks = [];
      if (!Array.isArray(entry.hooks)) throw new Error(`Invalid hooks for ${event}[${entryIndex}]`);
      entry.hooks.forEach((hook, hookIndex) => {
        const location = `${event}[${entryIndex}].hooks[${hookIndex}]`;
        const call = invocation(hook.command);
        if (call && trustedScript(call) && generatedShape(event, entry, hook, call)) {
          owned.push({ location, hook: call.name, kind: call.adapter ? 'adapter' : 'direct', command: hook.command });
        } else {
          hooks.push(hook);
          if (/codex-adapter|hooks_src[\\/]/i.test(`${hook.command || ''} ${hook.commandWindows || ''}`)) {
            ambiguous.push({ location, command: hook.command,
              reason: 'Citadel-like handler has an unverified root or differs from a known generated handler; preserved for review.' });
          }
        }
      });
      if (hooks.length) kept.push({ ...entry, hooks });
    });
    if (kept.length) preserved[event] = kept;
  }
  return { preserved, owned, ambiguous, diagnostics: ambiguous.map((item) => ({
    code: 'CODEX_HOOK_OWNERSHIP_AMBIGUOUS', severity: 'error', ...item, message: `${item.location}: ${item.reason}`,
  })) };
}

function assertUnambiguous(ownership) {
  if (!ownership.ambiguous.length) return;
  const error = new Error('Codex hook ownership is ambiguous; no hooks were changed. Review: '
    + ownership.ambiguous.map((item) => item.location).join(', '));
  error.code = 'CODEX_HOOK_OWNERSHIP_AMBIGUOUS';
  error.diagnostics = ownership.diagnostics;
  throw error;
}

// Detect positive registration evidence only; a .codex directory is not an
// installation. A disabled project setting does not erase an enabled global
// registration here: require the operator to remove that conflict explicitly.
function assertNoPluginHooks(projectRoot, options = {}) {
  const env = options.env || process.env;
  const home = env.CODEX_HOME || (env.USERPROFILE || env.HOME
    ? path.join(env.USERPROFILE || env.HOME, '.codex') : null);
  const files = options.pluginConfigPaths || [
    ...(home ? [path.join(home, 'config.toml')] : []), path.join(projectRoot, '.codex', 'config.toml'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const sections = text.split(/(?=^\s*\[)/m);
    for (const section of sections) {
      if (!/^\s*\[\s*plugins\s*\.\s*["']citadel@[^"']+["']\s*\]/.test(section)) continue;
      if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(section)) continue;
      const error = new Error(`Citadel plugin registration in ${file} may load hooks. Disable it before local fallback installation, or use --remove-local to keep plugin hooks only.`);
      error.code = 'CODEX_PLUGIN_HOOK_CONFLICT';
      throw error;
    }
  }
}

module.exports = { inspectCodexHookOwnership, assertUnambiguous, assertNoPluginHooks };
