#!/usr/bin/env node

'use strict';

// Verifies the opencode installer: the plugin stub, the opencode.json merge, and
// the agent projection. opencode hard-fails on invalid config, so the merge is
// asserted key by key against opencode's real schemas.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CITADEL_ROOT = path.resolve(__dirname, '..');
const {
  MCP_SERVER_NAME,
  PLUGIN_STUB_NAME,
  citadelMcpServer,
  installOpencodePlugin,
  mergeOpencodeConfig,
  renderPluginStub,
} = require(path.join(CITADEL_ROOT, 'runtimes', 'opencode', 'generators', 'install-plugin'));
const {
  projectOpencodeAgents,
  renderOpencodeAgent,
  yamlString,
} = require(path.join(CITADEL_ROOT, 'runtimes', 'opencode', 'generators', 'project-agents'));
const { OPENCODE_GUIDANCE_TARGET } = require(path.join(CITADEL_ROOT, 'runtimes', 'opencode', 'guidance', 'render'));

function scratchProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-oc-install-'));
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'do'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'do', 'SKILL.md'), '---\nname: do\ndescription: d\n---\nbody\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Demo\n');
  return root;
}

// opencode's McpLocalConfig is a plain Struct: `command` is one argv array, there
// is no `args` key, env is `environment`. An unknown key fails the decode and
// opencode hard-fails at startup, so this is asserted precisely.
function testMcpShape() {
  const server = citadelMcpServer('/citadel', '/project');
  assert.deepStrictEqual(Object.keys(server).sort(), ['command', 'enabled', 'environment', 'type']);
  assert.equal(server.type, 'local');
  assert(Array.isArray(server.command), 'command must be an argv array');
  assert.equal(server.command[0], 'node');
  assert(!('args' in server), 'opencode has no args key; command carries argv');
  assert(!('env' in server), 'opencode uses environment, not env');
  assert.equal(server.environment.CITADEL_RUNTIME, 'opencode');
}

// The config file is user-owned. Every key Citadel does not own must survive.
function testMergePreservesUserConfig() {
  const existing = {
    $schema: 'https://opencode.ai/config.json',
    theme: 'tokyonight',
    model: 'anthropic/claude-opus-5',
    mcp: { 'user-server': { type: 'local', command: ['echo', 'hi'] } },
    permission: { edit: 'ask' },
  };
  const { config, changes } = mergeOpencodeConfig(existing, { citadelRoot: '/citadel', projectRoot: '/project' });

  assert.equal(config.theme, 'tokyonight');
  assert.equal(config.model, 'anthropic/claude-opus-5');
  assert.deepStrictEqual(config.permission, { edit: 'ask' });
  assert.deepStrictEqual(config.mcp['user-server'], { type: 'local', command: ['echo', 'hi'] });
  assert(config.mcp[MCP_SERVER_NAME], 'the Citadel MCP server must be added');
  assert.deepStrictEqual(changes, [`set mcp.${MCP_SERVER_NAME}`]);

  // Merging again changes nothing: the installer must be idempotent.
  const second = mergeOpencodeConfig(config, { citadelRoot: '/citadel', projectRoot: '/project' });
  assert.deepStrictEqual(second.changes, [], 'a second merge must be a no-op');

  // A fresh project still gets a schema reference.
  const fresh = mergeOpencodeConfig(null, { citadelRoot: '/citadel', projectRoot: '/project' });
  assert.equal(fresh.config.$schema, 'https://opencode.ai/config.json');
  assert(fresh.changes.includes('added $schema'));
}

function testRefusesUnparseableConfig(root) {
  const configPath = path.join(root, 'opencode.json');
  fs.writeFileSync(configPath, '{ not json');
  assert.throws(
    () => installOpencodePlugin({ citadelRoot: CITADEL_ROOT, projectRoot: root, dryRun: true }),
    /not valid JSON/,
    'an unparseable opencode.json must be refused, never clobbered',
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ not json', 'the bad file must be left untouched');
  fs.rmSync(configPath);
}

function testDryRunWritesNothing(root) {
  const result = installOpencodePlugin({ citadelRoot: CITADEL_ROOT, projectRoot: root, dryRun: true });
  assert(result.writes.length > 0, 'a dry run must still report the writes it would make');
  assert.equal(fs.existsSync(path.join(root, '.opencode')), false, 'a dry run must not create .opencode');
  assert.equal(fs.existsSync(path.join(root, 'opencode.json')), false, 'a dry run must not create opencode.json');
}

async function testInstallAndStub(root) {
  const result = installOpencodePlugin({ citadelRoot: CITADEL_ROOT, projectRoot: root });
  const stubPath = path.join(root, '.opencode', 'plugin', PLUGIN_STUB_NAME);
  assert.equal(result.pluginPath, stubPath);
  assert(fs.existsSync(stubPath), 'the plugin stub must be written');

  // opencode auto-discovers .opencode/plugin/*.js, so the stub must be a loadable
  // ES module exporting the plugin factory.
  const loaded = await import(`file://${stubPath}`);
  assert.equal(typeof loaded.CitadelPlugin, 'function', 'the stub must export CitadelPlugin');
  assert.equal(typeof loaded.default, 'function', 'the stub must have a default export');

  // The stub points at the checkout so a Citadel upgrade needs no reinstall.
  const stub = fs.readFileSync(stubPath, 'utf8');
  assert(stub.includes('runtimes/opencode/plugin/index.mjs'), 'the stub must re-export from the checkout');
  assert(stub.includes('Generated by Citadel'), 'generated files must be marked');

  const again = installOpencodePlugin({ citadelRoot: CITADEL_ROOT, projectRoot: root });
  assert.deepStrictEqual(again.writes, [], 'a second install must be a no-op');

  // Windows path separators must not break the import specifier.
  const winStub = renderPluginStub('C:\\Users\\dev\\citadel');
  assert(winStub.includes('file://C:/Users/dev/citadel/'), 'backslashes must be normalized for the file URL');
}

function testAgentProjection(root) {
  const results = projectOpencodeAgents({ citadelRoot: CITADEL_ROOT, projectRoot: root });
  assert(results.length > 0, 'agents must be projected');

  for (const item of results) {
    const content = fs.readFileSync(item.targetPath, 'utf8');
    assert(content.startsWith('---\n'), `${item.name}: must open with frontmatter`);
    const end = content.indexOf('\n---\n', 4);
    assert(end > 0, `${item.name}: frontmatter must be closed`);
    const frontmatter = content.slice(4, end);

    // opencode takes the agent name from the file path, so a name key is noise.
    assert(!/^name:/m.test(frontmatter), `${item.name}: name comes from the filename, not frontmatter`);
    assert(/^mode: subagent$/m.test(frontmatter), `${item.name}: Citadel agents are subagents`);

    const description = frontmatter.match(/^description: "(.*)"$/m);
    assert(description, `${item.name}: description must be a quoted single-line scalar`);
    // A description reaches opencode's @ autocomplete, so stray YAML comment text
    // from the source frontmatter must not leak into it.
    assert(!description[1].includes('# '), `${item.name}: YAML comments must not leak into the description`);
    assert(!/\n/.test(description[1]), `${item.name}: description must not contain a raw newline`);
    assert(content.slice(end + 5).trim().length > 0, `${item.name}: prompt body must not be empty`);
  }
}

function testYamlQuoting() {
  assert.equal(yamlString('plain'), '"plain"');
  assert.equal(yamlString('has "quotes"'), '"has \\"quotes\\""');
  assert.equal(yamlString('line\nbreak'), '"line\\nbreak"');
  assert.equal(yamlString('back\\slash'), '"back\\\\slash"');
  assert.equal(yamlString(undefined), '""');

  // A description full of YAML metacharacters must still render on one line.
  const rendered = renderOpencodeAgent({
    name: 'x',
    frontmatter: { name: 'x', description: 'a: b # c "d"\nnext' },
    body: 'prompt',
  });
  const line = rendered.split('\n').find((item) => item.startsWith('description:'));
  assert.equal(line, 'description: "a: b # c \\"d\\"\\nnext"');
}

function testGuidanceTarget() {
  // opencode reads AGENTS.md then CLAUDE.md, so Citadel projects no new file.
  assert.equal(OPENCODE_GUIDANCE_TARGET.filePath, 'AGENTS.md');
  assert.equal(OPENCODE_GUIDANCE_TARGET.runtime, 'opencode');
  assert.equal(typeof OPENCODE_GUIDANCE_TARGET.render, 'function');
}

// Commands are deliberately not projected: opencode registers every discovered
// skill as a command, and an explicit command file shadows the skill, so a
// projected copy could go stale and override the live one.
function testNoCommandProjection(root) {
  assert.equal(
    fs.existsSync(path.join(root, '.opencode', 'command')),
    false,
    'commands must not be projected; opencode derives them from skills',
  );
  assert.equal(
    fs.existsSync(path.join(CITADEL_ROOT, 'runtimes', 'opencode', 'generators', 'project-commands.js')),
    false,
    'a command projector would shadow live skills',
  );
}

function testInstallerCli(root) {
  const install = require(path.join(CITADEL_ROOT, 'scripts', 'opencode-install'));
  const result = install.run(['--project-root', root, '--dry-run']);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert(result.degradations.some((item) => item.startsWith('stop-cannot-block')));
  assert(result.degradations.some((item) => item.startsWith('plugin-load-failure-fails-open')));
  assert(install.render(result).includes('derived from skills'));

  const missing = install.run(['--project-root', path.join(root, 'nope'), '--dry-run']);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);
}

async function main() {
  testMcpShape();
  testMergePreservesUserConfig();
  testYamlQuoting();
  testGuidanceTarget();

  const root = scratchProject();
  try {
    testRefusesUnparseableConfig(root);
    testDryRunWritesNothing(root);
    testInstallerCli(root);
    await testInstallAndStub(root);
    testAgentProjection(root);
    testNoCommandProjection(root);

    // The readiness check must pass on a freshly installed project.
    const readiness = require(path.join(CITADEL_ROOT, 'scripts', 'opencode-readiness-check'));
    const checks = await readiness.collect(root);
    const failed = checks.filter((item) => !item.pass);
    assert.deepStrictEqual(failed.map((item) => item.name), [], `readiness failures: ${JSON.stringify(failed)}`);

    console.log('opencode install tests pass.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
