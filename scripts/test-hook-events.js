#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeCodexHookInput } = require(path.join(__dirname, '..', 'runtimes', 'codex', 'adapters', 'hook-input'));
const { normalizeClaudeHookInput } = require(path.join(__dirname, '..', 'runtimes', 'claude-code', 'adapters', 'hook-input'));
const { normalizeOpencodeHookInput } = require(path.join(__dirname, '..', 'runtimes', 'opencode', 'adapters', 'hook-input'));
const { toLegacyHookPayload } = require(path.join(__dirname, '..', 'core', 'hooks', 'hook-context'));
const normalizeEvent = require(path.join(__dirname, '..', 'core', 'hooks', 'normalize-event'));

const OPENCODE_FIXTURE = path.join(__dirname, 'fixtures', 'opencode-hook-events.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// A hook must not be able to tell which runtime it is running under. For every
// fixture pair, the opencode payload and the equivalent Claude Code payload have
// to reduce to the same envelope fields.
function assertOpencodeEquivalence() {
  const fixture = JSON.parse(fs.readFileSync(OPENCODE_FIXTURE, 'utf8'));
  assert(fixture.equivalents.length > 0, 'opencode fixture has no equivalence cases');

  for (const item of fixture.equivalents) {
    const opencode = normalizeOpencodeHookInput(item.opencode);
    const claude = normalizeClaudeHookInput(item.claude);

    for (const [field, expected] of Object.entries(item.expect)) {
      assert.deepStrictEqual(
        opencode[field], expected,
        `${item.name}: opencode ${field} mismatch`,
      );
      assert.deepStrictEqual(
        claude[field], expected,
        `${item.name}: claude ${field} mismatch (fixture pair is not equivalent)`,
      );
    }

    assert.equal(opencode.runtime, 'opencode', `${item.name}: runtime mismatch`);
    assert.equal(
      opencode.native_event_name, item.opencode.hook_event_name,
      `${item.name}: native event name must be preserved for skip reporting`,
    );
    // The untouched payload has to survive: the plugin adapter mutates
    // opencode's own args object in place, which is the only mutation opencode
    // honors, so it cannot be handed a normalized copy.
    assert.strictEqual(opencode.raw, item.opencode, `${item.name}: raw payload must be the caller's object`);
  }

  // The fixture's mapped list and the shipped map must not drift apart.
  assert.deepStrictEqual(
    Object.keys(normalizeEvent.OPENCODE_EVENT_MAP).sort(),
    [...fixture.mapped].sort(),
    'opencode event map and fixture mapped list have drifted',
  );

  // Events we chose not to map must stay unmapped. Any of these silently
  // acquiring a Citadel event id would misreport the runtime's lifecycle.
  for (const native of Object.keys(fixture.deliberatelyUnmapped)) {
    assert.equal(
      normalizeEvent.OPENCODE_EVENT_MAP[native], undefined,
      `${native} must stay unmapped: ${fixture.deliberatelyUnmapped[native]}`,
    );
    // An unmapped name passes through rather than becoming a wrong event id.
    assert.equal(
      normalizeOpencodeHookInput({ hook_event_name: native }).event_id, native,
      `${native} should pass through as its native name`,
    );
  }

  assert.equal(normalizeEvent.eventMapFor('opencode'), normalizeEvent.OPENCODE_EVENT_MAP);
  assert.equal(normalizeEvent.eventMapFor('codex'), normalizeEvent.CODEX_EVENT_MAP);
  assert.equal(normalizeEvent.eventMapFor('claude-code'), normalizeEvent.CLAUDE_EVENT_MAP);
  assert.equal(normalizeEvent.eventMapFor('nope'), normalizeEvent.CLAUDE_EVENT_MAP);

  // An explicit file_path must win over opencode's filePath rather than being
  // silently overwritten.
  const bothKeys = normalizeOpencodeHookInput({
    hook_event_name: 'tool.execute.before',
    tool: 'read',
    args: { filePath: '/ignored', file_path: '/wins' },
  });
  assert.equal(bothKeys.tool_input.file_path, '/wins');

  // apply_patch keeps its native id so the adapter can split it per target.
  assert.equal(
    normalizeOpencodeHookInput({ hook_event_name: 'tool.execute.before', tool: 'apply_patch', args: {} }).tool_name,
    'apply_patch',
  );

  // A legacy payload built from an opencode envelope has to look like any other.
  const legacy = toLegacyHookPayload(normalizeOpencodeHookInput({
    hook_event_name: 'tool.execute.before',
    sessionID: 'ses_1',
    tool: 'edit',
    args: { filePath: '/repo/a.ts' },
  }));
  assert.equal(legacy.tool_name, 'Edit');
  assert.equal(legacy.tool_input.file_path, '/repo/a.ts');
  assert.equal(legacy._runtime, 'opencode');
  assert.equal(legacy._event_id, 'pre_tool');
  assert.equal(legacy._session_id, 'ses_1');
}

function main() {
  const codexEnvelope = normalizeCodexHookInput({
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    turn_id: 'turn-1',
    cwd: 'C:\\repo',
    transcript_path: 'C:\\repo\\.codex\\history.jsonl',
    model: 'gpt-5.4',
    tool_name: 'edit',
    tool_input: {
      file_path: 'C:\\repo\\src\\file.ts',
    },
  });

  if (codexEnvelope.runtime !== 'codex') fail('Codex envelope runtime mismatch');
  if (codexEnvelope.event_id !== 'pre_tool') fail('Codex envelope event id mismatch');
  if (codexEnvelope.tool_name !== 'Edit') fail('Codex envelope tool normalization mismatch');
  if (codexEnvelope.tool_input.file_path !== 'C:/repo/src/file.ts') fail('Codex envelope path normalization mismatch');

  const claudeEnvelope = normalizeClaudeHookInput({
    hook_event_name: 'PostToolUse',
    session_id: 'sess-2',
    tool_name: 'Write',
    tool_input: {
      path: 'C:\\repo\\README.md',
    },
  });

  if (claudeEnvelope.runtime !== 'claude-code') fail('Claude envelope runtime mismatch');
  if (claudeEnvelope.event_id !== 'post_tool') fail('Claude envelope event id mismatch');
  if (claudeEnvelope.tool_input.path !== 'C:/repo/README.md') fail('Claude envelope path normalization mismatch');

  const legacy = toLegacyHookPayload(codexEnvelope);
  if (legacy.tool_name !== 'Edit') fail('Legacy hook payload tool mismatch');
  if (legacy._runtime !== 'codex') fail('Legacy hook payload runtime metadata mismatch');

  const codexPermission = normalizeCodexHookInput({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
  });
  if (codexPermission.event_id !== 'permission_request') fail('Codex permission event normalization mismatch');

  const codexSubagent = normalizeCodexHookInput({
    hook_event_name: 'SubagentStart',
    subagent_type: 'explorer',
  });
  if (codexSubagent.event_id !== 'subagent_start') fail('Codex subagent event normalization mismatch');
  if (legacy._event_id !== 'pre_tool') fail('Legacy hook payload event metadata mismatch');

  assertOpencodeEquivalence();

  console.log('Hook event normalization tests pass.');
}

main();
