#!/usr/bin/env node

'use strict';

// Exercises the opencode plugin's hook runner against the real hooks_src
// processes. Runs under plain Node: no Bun and no opencode install required.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require(path.join(__dirname, '..', 'runtimes', 'opencode', 'plugin', 'hook-runner'));

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-opencode-'));
  fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
  return root;
}

function preTool(tool, args, extra = {}) {
  return { tool, args, directory: extra.directory, sessionID: 'ses_test', callID: 'call_test', ...extra };
}

async function testSecurityBlock(root) {
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# ok\n');

  const blocked = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('read', { filePath: path.join(root, '.env') }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(blocked.blocked, true, 'reading .env must be blocked');
  assert.match(blocked.reason, /\.env/, 'the block reason must come from the hook, not a generic message');
  assert(blocked.results.some((r) => r.hook === 'protect-files'), 'protect-files should have run');

  const allowed = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('read', { filePath: path.join(root, 'README.md') }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(allowed.blocked, false, 'reading README.md must not be blocked');

  const forcePush = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('bash', { command: 'git push --force origin main' }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(forcePush.blocked, true, 'a force-push must be blocked');
  assert.match(forcePush.reason, /P-001|invariant/i);

  const plainPush = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('bash', { command: 'git status' }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(plainPush.blocked, false, 'git status must not be blocked');
}

// A non-blocking event must never report blocked, even when a hook exits 2.
async function testPostToolNeverBlocks(root) {
  const outcome = await runner.runHooksForEvent(
    'tool.execute.after',
    preTool('write', { filePath: path.join(root, 'README.md') }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(outcome.blocked, false, 'tool.execute.after must never block a tool that already ran');
  assert.equal(outcome.templateEvent, 'PostToolUse');
}

// A security hook that cannot give a verdict has to fail closed on a blocking
// event, and stay silent on a non-blocking one.
async function testFailClosed(root) {
  const emptyHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-nohooks-'));

  const blocking = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('read', { filePath: path.join(root, '.env') }, { directory: root }),
    { projectRoot: root, hooksDir: emptyHooksDir },
  );
  assert.equal(blocking.blocked, true, 'a missing security hook must fail closed');
  assert.match(blocking.reason, /missing/);

  const observing = await runner.runHooksForEvent(
    'tool.execute.after',
    preTool('write', { filePath: path.join(root, 'README.md') }, { directory: root }),
    { projectRoot: root, hooksDir: emptyHooksDir },
  );
  assert.equal(observing.blocked, false, 'a missing observer must not block');
}

// Timeouts are enforced by the adapter, because opencode applies none of its own.
async function testTimeoutEnforced(root) {
  const slowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-slow-'));
  // A hook that never exits. The adapter must kill it and, for a security hook
  // on a blocking event, refuse the action.
  fs.writeFileSync(
    path.join(slowDir, 'protect-files.js'),
    'setInterval(() => {}, 1000);\n',
  );

  const template = {
    hooks: {
      PreToolUse: [{
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'node hooks_src/protect-files.js', timeout: 1 }],
      }],
    },
  };

  const started = Date.now();
  const outcome = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('read', { filePath: path.join(root, 'README.md') }, { directory: root }),
    { projectRoot: root, hooksDir: slowDir, template },
  );
  const elapsed = Date.now() - started;

  assert.equal(outcome.blocked, true, 'a timed-out security hook must fail closed');
  assert.match(outcome.reason, /timed out/);
  assert(outcome.results.some((r) => r.timedOut), 'the timeout must be recorded on the result');
  assert(elapsed < 10000, `the adapter must enforce its own timeout, took ${elapsed}ms`);
}

// apply_patch carries several targets in one call, so it must fan out into
// per-target Edit/Write payloads and be gated on each one.
function testApplyPatchProjection() {
  const operations = runner.parseApplyPatchOperations([
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '*** Add File: src/b.ts',
    '*** End Patch',
  ].join('\n'));
  assert.deepStrictEqual(operations, [
    { filePath: 'src/a.ts', toolName: 'Edit' },
    { filePath: 'src/b.ts', toolName: 'Write' },
  ]);

  assert.throws(() => runner.parseApplyPatchOperations('not a patch'), /boundaries/);
  assert.throws(() => runner.parseApplyPatchOperations(''), /non-empty/);

  // Without the alias, apply_patch matches none of the template's Edit|Write
  // matchers and would be gated by nothing at all.
  const { selected } = runner.selectHooks('PreToolUse', 'apply_patch');
  const names = selected.map((hook) => hook.name);
  assert(names.includes('protect-files'), 'apply_patch must still reach protect-files');
  assert(names.includes('governance'), 'apply_patch must still reach governance');
  assert(!names.includes('external-action-gate'), 'apply_patch must not reach the Bash-only gate');
}

async function testApplyPatchIsGated(root) {
  const patch = [
    '*** Begin Patch',
    '*** Update File: .env',
    '*** End Patch',
  ].join('\n');

  const outcome = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('apply_patch', { command: patch }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(outcome.blocked, true, 'an apply_patch touching .env must be blocked');

  // A patch body the adapter cannot parse must not slip through ungated.
  const unparseable = await runner.runHooksForEvent(
    'tool.execute.before',
    preTool('apply_patch', { command: 'garbage' }, { directory: root }),
    { projectRoot: root },
  );
  assert.equal(unparseable.blocked, true, 'an unparseable apply_patch must fail closed');
  assert.match(unparseable.reason, /apply_patch/);
}

function testEventCoverage() {
  // Every opencode event the runner claims to handle must resolve to a template
  // event that actually exists, or the mapping is a dead entry.
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks-template.json'), 'utf8'));
  for (const [opencodeEvent, templateEvent] of Object.entries(runner.TEMPLATE_EVENT_BY_OPENCODE_EVENT)) {
    assert(
      Object.prototype.hasOwnProperty.call(template.hooks, templateEvent),
      `${opencodeEvent} maps to ${templateEvent}, which is not in hooks-template.json`,
    );
  }

  // Only the pre-tool gate may abort a call.
  assert.deepStrictEqual([...runner.BLOCKING_OPENCODE_EVENTS], ['tool.execute.before']);

  // An unmapped event is a recorded skip, not a crash.
  return runner.runHooksForEvent('session.error', {}).then((outcome) => {
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.templateEvent, null);
    assert(outcome.skipped.length > 0, 'an unmapped event must be recorded as skipped');
  });
}

function testNodeBinaryResolution() {
  assert.equal(runner.resolveNodeBinary({ nodeBinary: '/custom/node' }), '/custom/node');
  const resolved = runner.resolveNodeBinary();
  assert(typeof resolved === 'string' && resolved.length > 0, 'a node binary must always resolve');
}

// The ESM shim is what opencode actually loads. Stub the runner through the CJS
// cache (index.mjs reaches it via createRequire, so it shares that cache) to
// prove the shim translates outcomes into opencode's throw/mutate contract.
async function testPluginShim(root) {
  const runnerPath = require.resolve(path.join(__dirname, '..', 'runtimes', 'opencode', 'plugin', 'hook-runner'));
  const realEntry = require.cache[runnerPath];
  const calls = [];
  let nextOutcome = { blocked: false, reason: null, messages: [], results: [], skipped: [] };

  require.cache[runnerPath] = {
    ...realEntry,
    exports: {
      TEMPLATE_EVENT_BY_OPENCODE_EVENT: runner.TEMPLATE_EVENT_BY_OPENCODE_EVENT,
      async runHooksForEvent(event, payload, options) {
        calls.push({ event, payload, options });
        return { event, ...nextOutcome };
      },
    },
  };

  try {
    const { CitadelPlugin } = await import(
      `../runtimes/opencode/plugin/index.mjs?cache=${Date.now()}`
    );
    const plugin = await CitadelPlugin({ directory: root, worktree: root });

    // Plugin init stands in for SessionStart.
    assert.equal(calls[0].event, 'plugin.init', 'plugin init must run the session-start hooks');

    // A blocked pre-tool outcome has to become a throw, carrying the hook's own
    // reason so the model sees why.
    nextOutcome = { blocked: true, reason: '[protect-files] Blocked: cannot read .env', messages: [], results: [], skipped: [] };
    const args = { filePath: path.join(root, '.env') };
    const output = { args };
    await assert.rejects(
      () => plugin['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, output),
      (error) => {
        assert.equal(error.name, 'CitadelBlockedError');
        assert.match(error.message, /cannot read \.env/);
        return true;
      },
      'a blocked pre-tool outcome must throw',
    );
    // The shim must hand opencode's own args object through, not a copy, and must
    // never replace it — assigning output.args is silently discarded by opencode.
    assert.strictEqual(output.args, args, 'output.args must not be replaced');
    const preToolCall = calls.find((call) => call.event === 'tool.execute.before');
    assert.strictEqual(preToolCall.payload.args, args, 'the live args object must reach the runner');

    // A post-tool outcome must never throw, even when hooks reported findings.
    nextOutcome = { blocked: true, reason: 'ignored', messages: ['[complexity-check] file is long'], results: [], skipped: [] };
    const afterOutput = { title: 't', output: 'done', metadata: {} };
    await plugin['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args: {} }, afterOutput);
    assert.match(afterOutput.output, /done/, 'the tool output must be preserved');
    assert.match(afterOutput.output, /complexity-check/, 'findings must be appended to the output');

    // chat.message injects by pushing onto the existing parts array; replacing
    // output.parts would be discarded by opencode.
    nextOutcome = { blocked: false, reason: null, messages: ['[citadel] campaign note'], results: [], skipped: [] };
    const parts = [{ type: 'text', text: 'hello' }];
    const chatOutput = { message: {}, parts };
    await plugin['chat.message']({ sessionID: 's' }, chatOutput);
    assert.strictEqual(chatOutput.parts, parts, 'output.parts must not be replaced');
    assert.equal(parts.length, 2, 'context must be pushed onto the existing array');
    assert.match(parts[1].text, /campaign note/);

    // A thrown runner must not break an observer path.
    require.cache[runnerPath].exports.runHooksForEvent = async () => { throw new Error('boom'); };
    await plugin['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args: {} }, { output: 'ok' });
    await plugin.dispose();

    // The event hook ignores bus events Citadel has no hooks for.
    await plugin.event({ event: { type: 'lsp.updated', properties: {} } });
  } finally {
    if (realEntry) require.cache[runnerPath] = realEntry;
    else delete require.cache[runnerPath];
  }
}

async function main() {
  const root = tempProject();
  try {
    testNodeBinaryResolution();
    testApplyPatchProjection();
    await testEventCoverage();
    await testSecurityBlock(root);
    await testPostToolNeverBlocks(root);
    await testFailClosed(root);
    await testTimeoutEnforced(root);
    await testApplyPatchIsGated(root);
    await testPluginShim(root);
    console.log('opencode adapter tests pass.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
