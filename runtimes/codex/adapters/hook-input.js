#!/usr/bin/env node

'use strict';

const path = require('path');
const { createEnvelope } = require(path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'normalize-event'));

function normalizeCodexHookInput(payload) {
  if (payload.tool_name === 'exec_command') {
    const input = payload.tool_input;
    if (!input || typeof input.cmd !== 'string'
      || (input.command !== undefined && input.command !== input.cmd)) {
      throw new TypeError('exec_command requires an unambiguous cmd string');
    }
    const envelope = createEnvelope('codex', payload.hook_event_name, {
      ...payload, tool_name: 'Bash', tool_input: { ...input, command: input.cmd },
    });
    return { ...envelope, raw: payload };
  }
  return createEnvelope('codex', payload.hook_event_name, payload);
}

module.exports = Object.freeze({
  normalizeCodexHookInput,
});
