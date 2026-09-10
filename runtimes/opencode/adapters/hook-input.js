#!/usr/bin/env node

'use strict';

const path = require('path');
const { createEnvelope } = require(path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'normalize-event'));

// opencode hooks are in-process functions called as (input, output), not command
// hooks fed a JSON payload on stdin. Its field names differ from the Claude Code
// and Codex payloads the rest of Citadel speaks:
//
//   input.sessionID   -> session_id        input.callID -> call_id
//   input.tool        -> tool_name         output.args  -> tool_input
//   plugin directory  -> cwd
//
// Accepting both the native aliases and the canonical snake_case keys keeps the
// phase-3 plugin adapter thin: it can pass `{ ...input, args: output.args }`
// straight through, and callers that already speak Citadel's payload shape are
// unaffected.
const ALIASES = Object.freeze([
  ['session_id', ['session_id', 'sessionID', 'sessionId']],
  ['turn_id', ['turn_id', 'turnID', 'turnId']],
  ['call_id', ['call_id', 'callID', 'callId']],
  ['tool_name', ['tool_name', 'tool', 'toolName']],
  ['tool_input', ['tool_input', 'args', 'toolInput']],
  ['cwd', ['cwd', 'directory', 'worktree']],
  ['model', ['model', 'modelID', 'modelId']],
  ['agent_id', ['agent_id', 'agent']],
]);

function firstDefined(payload, keys) {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) return payload[key];
  }
  return undefined;
}

function normalizeOpencodeHookInput(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const nativeEventName = source.hook_event_name
    || source.event_name
    || source.type
    || null;

  const flattened = { ...source };
  for (const [canonical, keys] of ALIASES) {
    const value = firstDefined(source, keys);
    if (value !== undefined) flattened[canonical] = value;
  }

  // `model` arrives as { providerID, modelID } on chat hooks; flatten it to the
  // string the rest of Citadel records.
  if (flattened.model && typeof flattened.model === 'object') {
    const { providerID, modelID } = flattened.model;
    flattened.model = [providerID, modelID].filter(Boolean).join('/') || null;
  }

  const envelope = createEnvelope('opencode', nativeEventName, flattened);
  // `raw` must stay the caller's untouched payload so the plugin adapter can
  // mutate opencode's own argument object (filePath, command) in place — the
  // only mutation opencode actually honors.
  return Object.freeze({
    ...envelope,
    call_id: flattened.call_id || null,
    raw: source,
  });
}

module.exports = Object.freeze({
  normalizeOpencodeHookInput,
});
