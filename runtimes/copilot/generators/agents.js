'use strict';

const fs = require('fs');
const path = require('path');
const { parseAgentContent } = require('../../../core/agents/parse-agent');
const { CANONICAL_AGENTS, loadRuntimeAgentSettings, resolveModel, modelGuidance } = require('../../../core/agents/runtime-settings');

const AGENTS_DIRECTORY = 'com.github.copilot/agents';

// Explicit allowlists preserve read-only roles. Unsupported Claude scheduling and
// task-ledger tools are omitted; never expand these to Copilot's wildcard default.
const TOOLS = Object.freeze({
  Read: ['view'], Glob: ['glob'], Grep: ['grep'], Write: ['create'], Edit: ['edit'],
  Bash: ['bash', 'powershell', 'read_bash', 'read_powershell', 'write_bash',
    'write_powershell', 'list_bash', 'list_powershell', 'stop_bash', 'stop_powershell'],
  Agent: ['task', 'list_agents', 'read_agent'], SendMessage: ['write_agent'],
  Skill: ['skill'], WebFetch: ['web_fetch'], WebSearch: [],
  CronCreate: [], CronDelete: [], CronList: [],
  TaskCreate: [], TaskList: [], TaskGet: [], TaskUpdate: [], NotebookEdit: [],
});

function projectAgent(name, content, settings = loadRuntimeAgentSettings('copilot')) {
  const parsed = parseAgentContent(name, content);
  if (parsed.errors.length) throw new Error(`${name}: ${parsed.errors.join(', ')}`);
  const fm = parsed.frontmatter;
  const model = resolveModel(fm.model, settings);
  if (!Array.isArray(fm.tools)) throw new Error(`${name}: explicit tools required`);
  const denied = new Set(fm.disallowedTools || []);
  const tools = [...new Set(fm.tools.filter(tool => !denied.has(tool)).flatMap(tool => {
    if (!Object.hasOwn(TOOLS, tool)) throw new Error(`${name}: unmapped Copilot tool ${tool}`);
    return TOOLS[tool];
  }))];
  if (tools.includes('create') && tools.includes('edit')) tools.push('apply_patch');
  const metadata = [
    `name: ${name}`, `description: ${JSON.stringify(fm.description)}`,
    `model: ${model}`, 'modelPolicy: required',
    ...(fm.effort ? [`reasoningEffort: ${fm.effort}`] : []),
    'include-custom-instructions: true', `tools: ${JSON.stringify(tools)}`,
  ];
  return `---\n${metadata.join('\n')}\n---\n\n<!-- Generated from ${CANONICAL_AGENTS}/${name}.md; do not edit. -->\n\n${modelGuidance(settings)}\n\n${parsed.body}\n`;
}

function projectAgentEntries(entries, settings = loadRuntimeAgentSettings('copilot')) {
  return entries.filter(entry => /^\.citadel\/agents\/[^/]+\.md$/.test(entry.name)).map(entry => ({
    name: `${AGENTS_DIRECTORY}/${path.posix.basename(entry.name, '.md')}.agent.md`,
    data: Buffer.from(projectAgent(path.posix.basename(entry.name, '.md'), entry.data.toString('utf8'), settings)),
    mode: 0o644,
  }));
}

function writeCopilotPluginAgents(options = {}) {
  const root = path.resolve(options.citadelRoot || path.join(__dirname, '../../..'));
  const sources = fs.readdirSync(path.join(root, CANONICAL_AGENTS)).filter(name => name.endsWith('.md'))
    .sort().map(name => ({ name: `${CANONICAL_AGENTS}/${name}`, data: fs.readFileSync(path.join(root, CANONICAL_AGENTS, name)) }));
  const projected = projectAgentEntries(sources, loadRuntimeAgentSettings('copilot', root));
  const directory = path.join(root, AGENTS_DIRECTORY);
  const expected = new Set(projected.map(entry => path.basename(entry.name)));
  const stale = fs.existsSync(directory) ? fs.readdirSync(directory)
    .filter(name => name.endsWith('.agent.md') && !expected.has(name)) : [];
  const changedPaths = stale.map(name => path.join(directory, name));
  for (const entry of projected) {
    const target = path.join(root, entry.name);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(entry.data)) continue;
    changedPaths.push(target);
    if (!options.check) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(target, entry.data);
    }
  }
  if (!options.check) for (const name of stale) fs.unlinkSync(path.join(directory, name));
  return { changed: changedPaths.length > 0, changedPaths, count: projected.length };
}

module.exports = { AGENTS_DIRECTORY, projectAgent, projectAgentEntries, writeCopilotPluginAgents };
