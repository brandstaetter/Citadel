'use strict';

const fs = require('fs');
const path = require('path');
const {
  translateCopilotHooks,
  validateCopilotConfig,
} = require('./install-hooks');

const PLUGIN_HOOKS_RELATIVE = 'com.github.copilot/hooks/hooks.json';
const PLUGIN_ADAPTER = '${PLUGIN_ROOT}/hooks_src/copilot-adapter.js';

function isCitadelPluginEnabled(output) {
  return String(output || '').split(/\r?\n/).some((line) =>
    /^\s*(?:[•*-]\s+)?citadel(?:@citadel-local)?\b/i.test(line) && !/\bdisabled\b/i.test(line));
}

function generateCopilotPluginHooks(options = {}) {
  const citadelRoot = path.resolve(options.citadelRoot || path.join(__dirname, '..', '..', '..'));
  const template = options.hooksTemplate || JSON.parse(
    fs.readFileSync(path.join(citadelRoot, 'hooks', 'hooks-template.json'), 'utf8'),
  );
  const translated = translateCopilotHooks(template, PLUGIN_ADAPTER, {
    effectiveBundles: options.effectiveBundles,
  });
  const config = { version: 1, hooks: translated.hooks };
  validateCopilotConfig(config);
  return { ...translated, config };
}

function writeCopilotPluginHooks(options = {}) {
  const citadelRoot = path.resolve(options.citadelRoot || path.join(__dirname, '..', '..', '..'));
  const outputPath = path.join(citadelRoot, ...PLUGIN_HOOKS_RELATIVE.split('/'));
  const generated = generateCopilotPluginHooks({ ...options, citadelRoot });
  const content = `${JSON.stringify(generated.config, null, 2)}\n`;
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  const changed = existing !== content;
  if (changed && !options.check) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
  }
  return { ...generated, outputPath, content, changed };
}

module.exports = Object.freeze({
  PLUGIN_ADAPTER,
  PLUGIN_HOOKS_RELATIVE,
  generateCopilotPluginHooks,
  isCitadelPluginEnabled,
  writeCopilotPluginHooks,
});
