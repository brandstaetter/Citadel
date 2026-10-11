#!/usr/bin/env node

'use strict';

process.env.CITADEL_RUNTIME = 'copilot';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeCopilotHookInput } = require('../runtimes/copilot/adapters/hook-input');
const { projectLegacyPayloads } = require('../core/hooks/project-legacy-payloads');

const SECURITY_HOOKS = new Set(['protect-files', 'external-action-gate']);
const CONTEXT_EVENTS = new Set([
  'sessionStart',
  'SessionStart',
  'subagentStart',
  'postToolUse',
  'PostToolUse',
  'postToolUseFailure',
  'PostToolUseFailure',
  'notification',
  'Notification',
]);
const STOP_EVENTS = new Set(['agentStop', 'Stop', 'subagentStop', 'SubagentStop']);

function isSecurityHook(hookName) {
  return SECURITY_HOOKS.has(hookName);
}

function failureResult(hookName, reason, error = null, nativeEventName = null) {
  const blocks = isSecurityHook(hookName);
  const detail = error?.message ? `: ${error.message}` : '';
  return {
    status: blocks ? 2 : 0,
    stdoutParts: [],
    stderr: `[copilot-adapter] ${hookName || 'unknown hook'} ${reason}${detail}\n`,
    nativeEventName,
  };
}

function validateSecurityEnvelope(hookName, envelope) {
  if (envelope.event_id !== 'pre_tool') {
    throw new TypeError('security hooks require preToolUse or PreToolUse');
  }
  if (typeof envelope.cwd !== 'string' || !envelope.cwd.trim()) {
    throw new TypeError('security hooks require a non-empty cwd');
  }
  if (!envelope.tool_input || typeof envelope.tool_input !== 'object' || Array.isArray(envelope.tool_input)) {
    throw new TypeError('security hooks require tool arguments object');
  }
  if (hookName === 'external-action-gate') {
    if (envelope.tool_name !== 'Bash' || typeof envelope.tool_input.command !== 'string'
      || !envelope.tool_input.command.trim()) {
      throw new TypeError('external-action-gate requires a Bash command');
    }
    return;
  }
  if (envelope.tool_name === 'apply_patch') {
    if (typeof envelope.tool_input.command !== 'string' || !envelope.tool_input.command.trim()) {
      throw new TypeError('protect-files apply_patch requires a patch command');
    }
    return;
  }
  if (!['Edit', 'Write', 'Read'].includes(envelope.tool_name)) {
    throw new TypeError('protect-files requires apply_patch, Edit, Write, or Read');
  }
  const filePath = envelope.tool_input.file_path || envelope.tool_input.path;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('protect-files requires a target path');
  }
}

function dispatchHook(hookName, configuredEventName, input, options = {}) {
  if (!hookName) return failureResult(hookName, 'name is missing', null, configuredEventName);
  const hooksDir = options.hooksDir || __dirname;
  const hookPath = path.join(hooksDir, `${hookName}.js`);
  if (!fs.existsSync(hookPath)) {
    return failureResult(hookName, 'implementation is missing', null, configuredEventName);
  }

  let payload;
  try {
    payload = input ? JSON.parse(input) : {};
  } catch (error) {
    return failureResult(hookName, 'input parse failed', error, configuredEventName);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failureResult(hookName, 'input must be a JSON object', null, configuredEventName);
  }

  let envelope;
  let legacyPayloads;
  try {
    envelope = normalizeCopilotHookInput(payload, configuredEventName);
    if (isSecurityHook(hookName)) validateSecurityEnvelope(hookName, envelope);
    legacyPayloads = projectLegacyPayloads(envelope);
  } catch (error) {
    return failureResult(hookName, 'input projection failed', error, configuredEventName);
  }

  const projectRoot = typeof envelope.cwd === 'string' && envelope.cwd.trim()
    ? path.resolve(envelope.cwd)
    : path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (isSecurityHook(hookName) && !fs.existsSync(projectRoot)) {
    return failureResult(hookName, 'project root does not exist', null, envelope.native_event_name);
  }

  const run = options.spawnSync || spawnSync;
  const stdoutParts = [];
  let stderr = '';
  for (const legacyPayload of legacyPayloads) {
    let result;
    try {
      result = run(process.execPath, [hookPath], {
        cwd: fs.existsSync(projectRoot) ? projectRoot : path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          CITADEL_RUNTIME: 'copilot',
          CLAUDE_PROJECT_DIR: projectRoot,
        },
        input: JSON.stringify(legacyPayload),
        encoding: 'utf8',
      });
    } catch (error) {
      const failure = failureResult(hookName, 'spawn failed', error, envelope.native_event_name);
      return { ...failure, stdoutParts, stderr: stderr + failure.stderr };
    }

    if (result.error || typeof result.status !== 'number') {
      const failure = failureResult(hookName, 'spawn failed', result.error, envelope.native_event_name);
      return {
        ...failure,
        stdoutParts: [...stdoutParts, result.stdout || ''].filter(Boolean),
        stderr: stderr + (result.stderr || '') + failure.stderr,
      };
    }

    stderr += result.stderr || '';
    if (result.status !== 0) {
      if (!isSecurityHook(hookName)) {
        if (result.stdout) stderr += result.stdout;
        stderr += `[copilot-adapter] ${hookName} observer exited with status ${result.status}; continuing.\n`;
        continue;
      }
      if (result.stdout) stdoutParts.push(result.stdout);
      return {
        status: 2,
        stdoutParts,
        stderr: result.status === 2
          ? stderr
          : `${stderr}[copilot-adapter] ${hookName} exited abnormally with status ${result.status}; blocking.\n`,
        nativeEventName: envelope.native_event_name,
      };
    }
    if (result.stdout) stdoutParts.push(result.stdout);
  }

  return { status: 0, stdoutParts, stderr, nativeEventName: envelope.native_event_name };
}

function parseHookOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { empty: true, malformed: false, value: null, text: '' };
  try {
    return { empty: false, malformed: false, value: JSON.parse(text), text };
  } catch {
    return { empty: false, malformed: /^(?:\{|\[)/.test(text), value: null, text };
  }
}

function contextFromOutput(parsed) {
  if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
    const specific = parsed.value.hookSpecificOutput;
    if (typeof specific?.additionalContext === 'string') return specific.additionalContext;
    if (typeof parsed.value.additionalContext === 'string') return parsed.value.additionalContext;
    if (typeof parsed.value.message === 'string') return parsed.value.message;
  }
  return parsed.value === null && !parsed.malformed ? parsed.text : null;
}

function translateOutput(nativeEventName, stdout) {
  const parsed = parseHookOutput(stdout);
  if (parsed.empty) return { output: null, diagnostic: '' };
  const value = parsed.value;

  if (CONTEXT_EVENTS.has(nativeEventName)) {
    const context = contextFromOutput(parsed);
    const output = {};
    if (typeof context === 'string' && context.trim()) output.additionalContext = context;
    if (nativeEventName === 'postToolUse' || nativeEventName === 'PostToolUse') {
      const modifiedResult = value?.modifiedResult || value?.hookSpecificOutput?.modifiedResult;
      if (modifiedResult && typeof modifiedResult === 'object' && !Array.isArray(modifiedResult)) {
        output.modifiedResult = modifiedResult;
      }
    }
    return Object.keys(output).length
      ? { output, diagnostic: '' }
      : { output: null, diagnostic: parsed.text };
  }

  if (nativeEventName === 'preToolUse' || nativeEventName === 'PreToolUse') {
    const specific = value?.hookSpecificOutput || value;
    if (!specific || typeof specific !== 'object' || Array.isArray(specific)) {
      return { output: null, diagnostic: parsed.text };
    }
    if (specific.decision === 'block') {
      return {
        output: {
          permissionDecision: 'deny',
          permissionDecisionReason: specific.reason || 'Citadel blocked this operation.',
        },
        diagnostic: '',
      };
    }
    const output = {};
    if (['allow', 'deny', 'ask'].includes(specific.permissionDecision)) {
      output.permissionDecision = specific.permissionDecision;
    }
    if (typeof specific.permissionDecisionReason === 'string') {
      output.permissionDecisionReason = specific.permissionDecisionReason;
    }
    const modifiedArgs = specific.modifiedArgs || specific.updatedInput;
    if (modifiedArgs && typeof modifiedArgs === 'object' && !Array.isArray(modifiedArgs)) {
      output.modifiedArgs = modifiedArgs;
    }
    return Object.keys(output).length
      ? { output, diagnostic: '' }
      : { output: null, diagnostic: parsed.text };
  }

  if (nativeEventName === 'permissionRequest' || nativeEventName === 'PermissionRequest') {
    const specific = value?.hookSpecificOutput || value;
    if (!specific || typeof specific !== 'object' || Array.isArray(specific)) {
      return { output: null, diagnostic: parsed.text };
    }
    const decision = specific.behavior || specific.permissionDecision || specific.decision?.behavior;
    if (!['allow', 'deny'].includes(decision)) return { output: null, diagnostic: parsed.text };
    return {
      output: {
        behavior: decision,
        ...(typeof specific.message === 'string' ? { message: specific.message }
          : typeof specific.decision?.message === 'string'
            ? { message: specific.decision.message }
          : typeof specific.permissionDecisionReason === 'string'
            ? { message: specific.permissionDecisionReason }
            : {}),
        ...(typeof specific.interrupt === 'boolean' ? { interrupt: specific.interrupt } : {}),
      },
      diagnostic: '',
    };
  }

  if (STOP_EVENTS.has(nativeEventName)) {
    const specific = value?.hookSpecificOutput || value;
    if (!specific || typeof specific !== 'object' || Array.isArray(specific)) {
      return { output: null, diagnostic: parsed.text };
    }
    const output = {};
    if (['block', 'allow'].includes(specific.decision)) {
      output.decision = specific.decision;
      if (typeof specific.reason === 'string') output.reason = specific.reason;
    }
    if ((nativeEventName === 'subagentStop' || nativeEventName === 'SubagentStop')
      && typeof specific.modifiedResponse === 'string') {
      output.modifiedResponse = specific.modifiedResponse;
    }
    return Object.keys(output).length
      ? { output, diagnostic: '' }
      : { output: null, diagnostic: parsed.text };
  }

  return { output: null, diagnostic: parsed.text };
}

function mergeOutputs(outputs) {
  if (outputs.length === 0) return null;
  const merged = {};
  const contexts = [];
  for (const output of outputs) {
    if (typeof output.additionalContext === 'string' && output.additionalContext.trim()) {
      contexts.push(output.additionalContext);
    }
    Object.assign(merged, output);
  }
  if (contexts.length) merged.additionalContext = contexts.join('\n\n');
  return merged;
}

function projectCopilotOutput(result) {
  const outputs = [];
  let stderr = result.stderr || '';
  for (const part of result.stdoutParts || []) {
    const translated = translateOutput(result.nativeEventName, part);
    if (translated.output) outputs.push(translated.output);
    if (translated.diagnostic) stderr += `${translated.diagnostic}\n`;
  }
  const output = mergeOutputs(outputs);
  const recoveryContext = ['postToolUseFailure', 'PostToolUseFailure'].includes(result.nativeEventName)
    && output
    && result.status === 0;
  return {
    stdout: output ? JSON.stringify(output) : '',
    stderr,
    status: recoveryContext ? 2 : result.status,
  };
}

function writeResult(result) {
  const projected = projectCopilotOutput(result);
  if (projected.stdout) process.stdout.write(projected.stdout);
  if (projected.stderr) process.stderr.write(projected.stderr);
  process.exit(projected.status);
}

function main(hookName = process.argv[2], eventName = process.argv[3]) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => writeResult(dispatchHook(hookName, eventName, input)));
}

if (require.main === module) main();

module.exports = Object.freeze({
  CONTEXT_EVENTS,
  SECURITY_HOOKS,
  STOP_EVENTS,
  dispatchHook,
  isSecurityHook,
  mergeOutputs,
  projectCopilotOutput,
  translateOutput,
  validateSecurityEnvelope,
});
