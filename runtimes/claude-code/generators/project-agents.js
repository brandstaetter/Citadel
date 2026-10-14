'use strict';

const fs = require('fs');
const path = require('path');
const { parseAgentContent } = require('../../../core/agents/parse-agent');
const { CANONICAL_AGENTS, loadRuntimeAgentSettings, resolveModel, modelGuidance } = require('../../../core/agents/runtime-settings');

function projectClaudeAgentEntries(entries, settings = loadRuntimeAgentSettings('claude-code')) {
  return entries.filter(entry => /^\.citadel\/agents\/[^/]+\.md$/.test(entry.name)).map(entry => {
    const name = path.posix.basename(entry.name, '.md');
    const source = entry.data.toString('utf8').replace(/\r\n/g, '\n');
    const parsed = parseAgentContent(name, source);
    if (parsed.errors.length) throw new Error(`${name}: ${parsed.errors.join(', ')}`);
    const model = resolveModel(parsed.frontmatter.model, settings);
    const projected = source.replace(/^model:.*$/m, `model: ${model}`);
    const fence = projected.indexOf('\n---', 4) + 4;
    const content = projected.slice(0, fence)
      + `\n\n<!-- Generated from ${entry.name}; do not edit. -->\n\n${modelGuidance(settings)}\n`
      + projected.slice(fence);
    return { name: `agents/${name}.md`, data: Buffer.from(content), mode: 0o644 };
  });
}

function writeClaudeAgents(options = {}) {
  const root = path.resolve(options.citadelRoot || path.join(__dirname, '../../..'));
  const entries = fs.readdirSync(path.join(root, CANONICAL_AGENTS)).filter(name => name.endsWith('.md'))
    .sort().map(name => ({ name: `${CANONICAL_AGENTS}/${name}`, data: fs.readFileSync(path.join(root, CANONICAL_AGENTS, name)) }));
  const projected = projectClaudeAgentEntries(entries, loadRuntimeAgentSettings('claude-code', root));
  const expected = new Set(projected.map(entry => entry.name));
  const directory = path.join(root, 'agents');
  const stale = fs.existsSync(directory) ? fs.readdirSync(directory)
    .filter(name => name.endsWith('.md') && !expected.has(`agents/${name}`)) : [];
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

module.exports = { projectClaudeAgentEntries, writeClaudeAgents };
