#!/usr/bin/env node

'use strict';

const path = require('path');
const { createEnvelope } = require(path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'normalize-event'));

// Copilot passes apply_patch arguments as the raw patch text rather than a
// JSON object. Wrap it as `command`, which the patch splitter reads. Other
// tools keep the fail-closed behavior for unparseable string arguments.
function wrapRawPatchArgs(toolName, toolArgs) {
  if (String(toolName || '').toLowerCase() !== 'apply_patch' || typeof toolArgs !== 'string') {
    return toolArgs;
  }
  try {
    const parsed = JSON.parse(toolArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* raw patch text */ }
  return { command: toolArgs };
}

function normalizeCopilotHookInput(payload, configuredEventName = null) {
  const nativeEventName = payload.hook_event_name || payload.event_name || configuredEventName;
  const toolName = payload.toolName || payload.tool_name;
  const toolArgs = wrapRawPatchArgs(toolName, payload.toolArgs);
  // Keep `raw` identical to the caller's payload unless the args were wrapped.
  const prepared = toolArgs === payload.toolArgs ? payload : { ...payload, toolArgs };
  return createEnvelope('copilot', nativeEventName, prepared);
}

/**
 * Normalize a Copilot hook payload into one envelope per tool call.
 *
 * Copilot CLI 1.0.95+ sends tool events as a batch:
 *   { sessionId, cwd, toolCalls: [{ id, name, args }, ...] }
 * Each call becomes its own envelope carrying the shared session fields, so
 * security hooks can evaluate every call. Payloads without `toolCalls` keep
 * the single-tool shape (`toolName` / `toolArgs`) and yield one envelope.
 * A `toolCalls` value that is not an array, or a call that is not an object,
 * throws so security hooks fail closed.
 */
function normalizeCopilotHookInputs(payload, configuredEventName = null) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'toolCalls')) {
    return [normalizeCopilotHookInput(payload, configuredEventName)];
  }
  if (!Array.isArray(payload.toolCalls)) {
    throw new TypeError('toolCalls must be an array');
  }
  const { toolCalls, ...shared } = payload;
  if (toolCalls.length === 0) return [normalizeCopilotHookInput(shared, configuredEventName)];
  return toolCalls.map((call, index) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) {
      throw new TypeError(`toolCalls[${index}] must be an object`);
    }
    return normalizeCopilotHookInput({
      ...shared,
      toolName: call.name ?? call.toolName,
      toolArgs: call.args ?? call.toolArgs ?? {},
      ...(call.id !== undefined ? { toolCallId: call.id } : {}),
    }, configuredEventName);
  });
}

module.exports = Object.freeze({
  normalizeCopilotHookInput,
  normalizeCopilotHookInputs,
});
