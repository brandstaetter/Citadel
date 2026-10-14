'use strict';

const fs = require('fs');
const path = require('path');

const MODEL_PLACEHOLDERS = Object.freeze(['xlarge', 'large', 'medium', 'small']);
const CANONICAL_AGENTS = '.citadel/agents';

function validateRuntimeAgentSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'models')) {
    throw new Error('Agent settings must contain only a models mapping');
  }
  const models = value.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)
    || Object.keys(models).length !== MODEL_PLACEHOLDERS.length) {
    throw new Error('Agent models must map exactly xlarge, large, medium, small');
  }
  for (const tier of MODEL_PLACEHOLDERS) {
    if (typeof models[tier] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(models[tier])
      || MODEL_PLACEHOLDERS.includes(models[tier])) {
      throw new Error(`Invalid or unresolved model mapping for ${tier}`);
    }
  }
  return Object.freeze({ models: Object.freeze({ ...models }) });
}

function loadRuntimeAgentSettings(runtime, root = path.resolve(__dirname, '../..')) {
  if (!['claude-code', 'copilot', 'codex'].includes(runtime)) throw new Error(`Unknown agent runtime: ${runtime}`);
  const file = path.join(root, 'runtimes', runtime, 'agent-settings.json');
  return validateRuntimeAgentSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function resolveModel(placeholder, settings) {
  if (!MODEL_PLACEHOLDERS.includes(placeholder)) throw new Error(`Unknown model placeholder: ${placeholder}`);
  return validateRuntimeAgentSettings(settings).models[placeholder];
}

function modelGuidance(settings) {
  const models = validateRuntimeAgentSettings(settings).models;
  return `Runtime model mapping: ${MODEL_PLACEHOLDERS.map(tier => `${tier} = ${models[tier]}`).join('; ')}. `
    + 'Resolve placeholders through this mapping before explicit worker calls. For named Citadel agents, '
    + 'omit per-call model overrides to retain their configured model. Never send a placeholder to the runtime. '
    + 'If a required model is unavailable, report it instead of silently downgrading.';
}

module.exports = { MODEL_PLACEHOLDERS, CANONICAL_AGENTS, validateRuntimeAgentSettings, loadRuntimeAgentSettings, resolveModel, modelGuidance };
