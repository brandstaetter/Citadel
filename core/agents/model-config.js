#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { loadRuntimeAgentSettings, MODEL_PLACEHOLDERS } = require('./runtime-settings');
const RUNTIME_MODELS = loadRuntimeAgentSettings('codex').models;
const LEGACY_TIERS = Object.freeze({ fable: 'xlarge', opus: 'large', sonnet: 'medium', haiku: 'small' });

const CODEX_AGENT_EXTENSION = 'citadel.codex-agents';
const CODEX_REASONING_EFFORTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_CODEX_AGENT_CONFIG = Object.freeze({
  defaultModel: RUNTIME_MODELS.medium,
  defaultReasoningEffort: 'high',
  modelAliases: Object.freeze({
    ...RUNTIME_MODELS,
    ...Object.fromEntries(Object.entries(LEGACY_TIERS).map(([alias, tier]) => [alias, RUNTIME_MODELS[tier]])),
  }),
  agents: Object.freeze({}),
});

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, allowed, label) {
  if (!plain(value)) throw new TypeError(`${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} has unknown fields: ${unknown.join(', ')}`);
}

function assertModelId(value, label) {
  if (typeof value !== 'string' || !MODEL_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a safe model ID`);
  }
}

function assertEffort(value, label) {
  if (!CODEX_REASONING_EFFORTS.includes(value)) {
    throw new TypeError(`${label} must be one of ${CODEX_REASONING_EFFORTS.join(', ')}`);
  }
}

function normalizeCodexAgentConfig(value = {}) {
  exactFields(value, ['defaultModel', 'defaultReasoningEffort', 'modelAliases', 'agents'], CODEX_AGENT_EXTENSION);
  const defaultModel = value.defaultModel ?? DEFAULT_CODEX_AGENT_CONFIG.defaultModel;
  const defaultReasoningEffort = value.defaultReasoningEffort
    ?? DEFAULT_CODEX_AGENT_CONFIG.defaultReasoningEffort;
  assertModelId(defaultModel, `${CODEX_AGENT_EXTENSION}.defaultModel`);
  assertEffort(defaultReasoningEffort, `${CODEX_AGENT_EXTENSION}.defaultReasoningEffort`);

  const aliases = value.modelAliases ?? {};
  if (!plain(aliases)) throw new TypeError(`${CODEX_AGENT_EXTENSION}.modelAliases must be a plain object`);
  const modelAliases = { ...DEFAULT_CODEX_AGENT_CONFIG.modelAliases };
  for (const [alias, model] of Object.entries(aliases)) {
    if (!AGENT_NAME_PATTERN.test(alias)) {
      throw new TypeError(`${CODEX_AGENT_EXTENSION}.modelAliases has an invalid alias: ${alias}`);
    }
    assertModelId(model, `${CODEX_AGENT_EXTENSION}.modelAliases.${alias}`);
    modelAliases[alias] = model;
    // Keep existing project alias overrides working after canonical tier migration.
    if (LEGACY_TIERS[alias] && !(LEGACY_TIERS[alias] in aliases)) modelAliases[LEGACY_TIERS[alias]] = model;
  }

  const configuredAgents = value.agents ?? {};
  if (!plain(configuredAgents)) throw new TypeError(`${CODEX_AGENT_EXTENSION}.agents must be a plain object`);
  const agents = {};
  for (const [agentName, override] of Object.entries(configuredAgents)) {
    if (!AGENT_NAME_PATTERN.test(agentName)) {
      throw new TypeError(`${CODEX_AGENT_EXTENSION}.agents has an invalid agent name: ${agentName}`);
    }
    exactFields(override, ['model', 'reasoningEffort'], `${CODEX_AGENT_EXTENSION}.agents.${agentName}`);
    if (!('model' in override) && !('reasoningEffort' in override)) {
      throw new TypeError(`${CODEX_AGENT_EXTENSION}.agents.${agentName} must override model or reasoningEffort`);
    }
    if ('model' in override) assertModelId(override.model, `${CODEX_AGENT_EXTENSION}.agents.${agentName}.model`);
    if ('reasoningEffort' in override) {
      assertEffort(override.reasoningEffort, `${CODEX_AGENT_EXTENSION}.agents.${agentName}.reasoningEffort`);
    }
    agents[agentName] = Object.freeze({ ...override });
  }

  return Object.freeze({
    defaultModel,
    defaultReasoningEffort,
    modelAliases: Object.freeze(modelAliases),
    agents: Object.freeze(agents),
  });
}

function configFromHarness(raw) {
  const extension = plain(raw?.extensions) ? raw.extensions[CODEX_AGENT_EXTENSION] : undefined;
  return normalizeCodexAgentConfig(extension ?? {});
}

function loadCodexAgentConfig(projectRoot) {
  const configPath = path.join(path.resolve(projectRoot), '.claude', 'harness.json');
  if (!fs.existsSync(configPath)) return DEFAULT_CODEX_AGENT_CONFIG;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot project Codex agents from invalid ${configPath}: ${error.message}`);
  }
  return configFromHarness(raw);
}

function modelFamily(sourceModel) {
  const normalized = String(sourceModel || '').toLowerCase();
  if (MODEL_PLACEHOLDERS.includes(normalized)) return normalized;
  for (const family of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (normalized === family || normalized.includes(`-${family}-`)) return family;
  }
  return null;
}

function resolveCodexAgentSettings(parsedAgent, config = DEFAULT_CODEX_AGENT_CONFIG) {
  const normalized = normalizeCodexAgentConfig(config);
  const agentName = parsedAgent.frontmatter.name || parsedAgent.name;
  const override = normalized.agents[agentName] || {};
  const family = modelFamily(parsedAgent.frontmatter.model);
  const sourceEffort = parsedAgent.frontmatter.effort;
  return Object.freeze({
    model: override.model
      || (family ? normalized.modelAliases[family] : null)
      || normalized.defaultModel,
    reasoningEffort: override.reasoningEffort
      || (CODEX_REASONING_EFFORTS.includes(sourceEffort) ? sourceEffort : null)
      || normalized.defaultReasoningEffort,
  });
}

module.exports = Object.freeze({
  AGENT_NAME_PATTERN,
  CODEX_AGENT_EXTENSION,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_AGENT_CONFIG,
  MODEL_ID_PATTERN,
  configFromHarness,
  loadCodexAgentConfig,
  modelFamily,
  normalizeCodexAgentConfig,
  resolveCodexAgentSettings,
});
