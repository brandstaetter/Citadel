#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { validateRuntimeAgentSettings, loadRuntimeAgentSettings, resolveModel } = require('../core/agents/runtime-settings');
const { run: generateRuntimeAgents } = require('./generate-runtime-agents');
const config = require(path.join(__dirname, '..', 'core', 'config'));
const { loadAgent } = require(path.join(__dirname, '..', 'core', 'agents', 'parse-agent'));
const { renderCodexToml, projectAgentToCodex } = require(path.join(__dirname, '..', 'core', 'agents', 'project-agent'));
const {
  CODEX_AGENT_EXTENSION,
  configFromHarness,
} = require(path.join(__dirname, '..', 'core', 'agents', 'model-config'));
const { projectCodexAgents } = require(path.join(__dirname, '..', 'runtimes', 'codex', 'generators', 'project-agents'));
const {
  buildPlan,
  parseArgs,
} = require(path.join(__dirname, 'citadel-config'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const root = path.resolve(__dirname, '..');
  assert.equal(require('../runtimes/claude-code/generators/project-agents').writeClaudeAgents({ check: true }).changed, false);
  assert.equal(require('../runtimes/copilot/generators/agents').writeCopilotPluginAgents({ check: true }).changed, false);
  assert.throws(() => validateRuntimeAgentSettings({ models: { large: 'example-model' } }), /exactly/);
  const copilotDefaults = loadRuntimeAgentSettings('copilot');
  assert.throws(() => resolveModel('opus', copilotDefaults), /Unknown model placeholder/);
  assert.throws(() => validateRuntimeAgentSettings({ models: { ...copilotDefaults.models, small: 'small' } }), /unresolved/);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-runtime-models-'));
  try {
    fs.cpSync(path.join(root, '.citadel/agents'), path.join(fixture, '.citadel/agents'), { recursive: true });
    for (const runtime of ['claude-code', 'copilot']) {
      fs.mkdirSync(path.join(fixture, 'runtimes', runtime), { recursive: true });
      const settings = loadRuntimeAgentSettings(runtime);
      fs.writeFileSync(path.join(fixture, 'runtimes', runtime, 'agent-settings.json'), JSON.stringify({
        models: { ...settings.models, xlarge: `${runtime}-judge-model`, large: `${runtime}-worker-model` },
      }));
    }
    const canonical = fs.readFileSync(path.join(fixture, '.citadel/agents/archon.md'), 'utf8');
    assert.equal(generateRuntimeAgents({ citadelRoot: fixture, projectRoot: fixture, check: true }).ok, false);
    assert.equal(fs.existsSync(path.join(fixture, 'agents')), false, 'check must not write');
    assert.equal(fs.existsSync(path.join(fixture, '.codex')), false, 'Codex check must not write');
    const generated = generateRuntimeAgents({ citadelRoot: fixture, projectRoot: fixture });
    assert.equal(generated.results.codex.count, 7);
    const codexAgent = path.join(fixture, '.codex/agents/archon.toml');
    assert(fs.readFileSync(codexAgent, 'utf8').includes(`model = "${loadRuntimeAgentSettings('codex').models.large}"`));
    assert.match(fs.readFileSync(path.join(fixture, 'agents/archon.md'), 'utf8'), /^model: claude-code-worker-model$/m);
    assert.match(fs.readFileSync(path.join(fixture, 'agents/arbiter.md'), 'utf8'), /^model: claude-code-judge-model$/m);
    assert.match(fs.readFileSync(path.join(fixture, 'com.github.copilot/agents/archon.agent.md'), 'utf8'), /^model: copilot-worker-model$/m);
    assert.match(fs.readFileSync(path.join(fixture, 'com.github.copilot/agents/arbiter.agent.md'), 'utf8'), /^model: copilot-judge-model$/m);
    assert.equal(fs.readFileSync(path.join(fixture, '.citadel/agents/archon.md'), 'utf8'), canonical);
    assert.equal(generateRuntimeAgents({ citadelRoot: fixture, projectRoot: fixture, check: true }).ok, true);
    fs.writeFileSync(codexAgent, 'stale');
    const checked = generateRuntimeAgents({ citadelRoot: fixture, projectRoot: fixture, check: true });
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.results.codex.changedPaths, [codexAgent]);
    assert.equal(fs.readFileSync(codexAgent, 'utf8'), 'stale');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  const agentPath = path.join(__dirname, '..', '.citadel', 'agents', 'archon.md');
  const parsed = loadAgent(agentPath);
  if (parsed.errors.length > 0) {
    fail(`Parsed agent has validation errors: ${parsed.errors.join('; ')}`);
  }

  const toml = renderCodexToml(parsed);
  assert.match(renderCodexToml(parsed, { agentConfig: { modelAliases: { large: 'custom-codex-model' } } }), /model = "custom-codex-model"/);
  assert.match(renderCodexToml(parsed, { agentConfig: { modelAliases: { opus: 'legacy-codex-model' } } }), /model = "legacy-codex-model"/);
  if (!toml.includes('name = "archon"')) {
    fail('Generated TOML is missing the expected agent name');
  }
  if (!toml.includes(`model = "${loadRuntimeAgentSettings('codex').models.large}"`)) {
    fail('Generated TOML is missing the expected model mapping');
  }
  if (!toml.includes('model_reasoning_effort = "high"')) {
    fail('Generated TOML is missing the expected reasoning effort');
  }

  const reviewer = loadAgent(path.join(__dirname, '..', '.citadel', 'agents', 'arch-reviewer.md'));
  const reviewerToml = renderCodexToml(reviewer);
  if (!reviewerToml.includes('does not machine-enforce Citadel tool allow/deny lists')
    || !reviewerToml.includes('Use only these declared tools: Read, Grep, Glob.')
    || !reviewerToml.includes('Do not use these declared tools: Edit, Write, Bash, NotebookEdit.')) {
    fail('Restricted Codex projection did not disclose and preserve the canonical tool policy');
  }

  const validator = loadAgent(path.join(__dirname, '..', '.citadel', 'agents', 'phase-validator.md'));
  if (JSON.stringify(validator.frontmatter.tools) !== JSON.stringify(['Read'])
    || !validator.body.includes('Use at most one Read')
    || !validator.body.includes('do not do it')) {
    fail('Phase Validator is not bounded to HANDOFF-only validation');
  }
  const validatorToml = renderCodexToml(validator);
  if (!validatorToml.includes('Use only these declared tools: Read.')
    || /Use only these declared tools:[^\n]*(Grep|Glob)/.test(validatorToml)) {
    fail('Phase Validator Codex projection expanded the bounded tool contract');
  }

  const fleetSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'fleet', 'SKILL.md'), 'utf8');
  if (/mode:\s*["']bypassPermissions["']/.test(fleetSkill)) {
    fail('Fleet skill still directs spawned agents to bypass native permissions');
  }
  if (!fleetSkill.includes("the host's native permission policy")) {
    fail('Fleet skill does not explicitly preserve the host permission policy');
  }
  const archonSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'archon', 'SKILL.md'), 'utf8');
  const campaignDocs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CAMPAIGNS.md'), 'utf8');
  if (!archonSkill.includes('do not replace it with a raw general-purpose mega-prompt')
    || !archonSkill.includes('never hardcode provider model IDs')
    || !fleetSkill.includes('Never hardcode provider model IDs')
    || !campaignDocs.includes('| Phase Type | Worker tier | Effort |')) {
    fail('Runtime-neutral worker tiers or Marshal routing guidance is missing');
  }

  const arbiter = loadAgent(path.join(__dirname, '..', '.citadel', 'agents', 'arbiter.md'));
  const arbiterToml = renderCodexToml(arbiter);
  if (!arbiterToml.includes(`model = "${loadRuntimeAgentSettings('codex').models.xlarge}"`)) {
    fail('Arbiter did not use the configured Codex xlarge mapping');
  }
  if (!arbiterToml.includes('model_reasoning_effort = "max"')) {
    fail('Arbiter did not retain its current max effort default');
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-agent-proj-'));
  const targetBase = path.join(tmpRoot, '.codex', 'agents');
  const result = projectAgentToCodex(agentPath, targetBase);

  if (!fs.existsSync(result.output.tomlPath)) {
    fail('Projected agent TOML was not written');
  }

  const projectedToml = fs.readFileSync(result.output.tomlPath, 'utf8');
  if (!projectedToml.includes('developer_instructions = """')) {
    fail('Projected TOML is missing developer instructions');
  }

  const raw = config.createDefaultConfig();
  const args = parseArgs([
    'configure-codex-agents',
    '--model-alias', 'opus=gpt-5.6-terra',
    '--agent-model', 'archon=gpt-5.6-sol',
    '--agent-effort', 'archon=ultra',
  ]);
  const plan = buildPlan(raw, args);
  if (plan.blocked || !plan.candidateConfig) {
    fail(`Configurable agent plan was blocked: ${plan.errors.join('; ')}`);
  }
  const extension = plan.candidateConfig.extensions[CODEX_AGENT_EXTENSION];
  if (extension.agents.archon.reasoningEffort !== 'ultra') {
    fail('Config plan did not preserve the Codex-only ultra override');
  }
  const configured = configFromHarness(plan.candidateConfig);
  const configuredToml = renderCodexToml(parsed, { agentConfig: configured });
  if (!configuredToml.includes('model = "gpt-5.6-sol"')
    || !configuredToml.includes('model_reasoning_effort = "ultra"')) {
    fail('Per-agent model and effort overrides did not win over the family mapping');
  }

  const projectRoot = path.join(tmpRoot, 'configured-project');
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.claude', 'harness.json'),
    `${JSON.stringify(plan.candidateConfig, null, 2)}\n`,
    'utf8',
  );
  projectCodexAgents({
    citadelRoot: path.join(__dirname, '..'),
    projectRoot,
    agentName: 'archon',
  });
  const configuredProjection = fs.readFileSync(
    path.join(projectRoot, '.codex', 'agents', 'archon.toml'),
    'utf8',
  );
  if (!configuredProjection.includes('model_reasoning_effort = "ultra"')) {
    fail('Project generator did not load the governed model configuration');
  }
  projectCodexAgents({
    citadelRoot: path.join(__dirname, '..'),
    projectRoot,
    agentName: 'phase-validator',
  });
  const validatorProjection = fs.readFileSync(
    path.join(projectRoot, '.codex', 'agents', 'phase-validator.toml'),
    'utf8',
  );
  if (!validatorProjection.includes('Use only these declared tools: Read.')
    || validatorProjection.includes('Use only these declared tools: Read, Glob, Grep.')) {
    fail('Generated Phase Validator projection did not retain its bounded tool contract');
  }

  const rejectedPlan = buildPlan(raw, parseArgs([
    'configure-codex-agents',
    '--agent-effort', 'archon=extreme',
  ]));
  if (!rejectedPlan.blocked
    || !rejectedPlan.errors.some((error) => /low, medium, high, xhigh, max, ultra/.test(error))) {
    fail('Unsupported Codex reasoning effort did not fail closed');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('Agent projection tests pass.');
}

main();
