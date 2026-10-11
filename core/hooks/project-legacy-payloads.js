#!/usr/bin/env node

'use strict';

const path = require('path');
const { toLegacyHookPayload } = require('./hook-context');

function parseApplyPatchOperations(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new TypeError('apply_patch tool_input.command must be a non-empty string');
  }
  if (!/^\*\*\* Begin Patch\s*$/m.test(command) || !/^\*\*\* End Patch\s*$/m.test(command)) {
    throw new TypeError('apply_patch command is missing patch boundaries');
  }

  const operations = [];
  const seen = new Set();
  for (const line of command.split(/\r?\n/)) {
    const fileMatch = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line);
    const moveMatch = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (!fileMatch && !moveMatch) continue;
    let target = (fileMatch ? fileMatch[2] : moveMatch[1]).trim();
    if ((target.startsWith('"') && target.endsWith('"'))
      || (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1);
    }
    if (!target) throw new TypeError('apply_patch contains an empty target path');
    const toolName = fileMatch?.[1] === 'Add' || moveMatch ? 'Write' : 'Edit';
    const signature = `${toolName}\0${target}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      operations.push({ filePath: target, toolName });
    }
  }
  if (operations.length === 0) {
    throw new TypeError('apply_patch command contains no target paths');
  }
  return operations;
}

function extractApplyPatchTargets(command) {
  return [...new Set(parseApplyPatchOperations(command).map((operation) => operation.filePath))];
}

function projectLegacyPayloads(envelope, options = {}) {
  const legacy = {
    ...(envelope.raw || {}),
    ...toLegacyHookPayload(envelope),
  };
  if (envelope.tool_name !== 'apply_patch') return [legacy];

  const projectRoot = typeof envelope.cwd === 'string' && envelope.cwd.trim()
    ? path.resolve(envelope.cwd)
    : path.resolve(options.projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  return parseApplyPatchOperations(envelope.tool_input?.command).map(({ filePath, toolName }) => ({
    ...legacy,
    tool_name: toolName,
    tool_input: {
      ...legacy.tool_input,
      file_path: path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(projectRoot, filePath),
    },
  }));
}

module.exports = Object.freeze({
  extractApplyPatchTargets,
  parseApplyPatchOperations,
  projectLegacyPayloads,
});
