#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { listRuntimeIds } = require('./registry');

const VALID_RUNTIMES = listRuntimeIds();

// Longest-prefix-first: "opencode" contains neither "codex" nor "claude", but
// keeping it ahead of both keeps the intent obvious and survives renames.
const PROCESS_TREE_MARKERS = Object.freeze([
  ['opencode', 'opencode'],
  ['codex', 'codex'],
  ['claude', 'claude-code'],
]);

// Claude Code leads so a tie on marker mtime resolves to claude-code, matching
// the behavior before opencode joined the list.
const DIRECTORY_MARKERS = Object.freeze([
  ['.claude', 'claude-code'],
  ['.codex', 'codex'],
  ['.opencode', 'opencode'],
]);

function detectRuntime(projectRoot) {
  const root = projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const envRuntime = process.env.CITADEL_RUNTIME;
  if (envRuntime && VALID_RUNTIMES.includes(envRuntime)) {
    return { runtime: envRuntime, method: 'env' };
  }

  try {
    const isWin = process.platform === 'win32';
    let parentInfo = '';
    if (isWin) {
      try {
        parentInfo = execFileSync(
          'wmic', ['process', 'where', `ProcessId=${process.ppid}`, 'get', 'CommandLine', '/format:list'],
          { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toLowerCase();
      } catch {
        parentInfo = execFileSync(
          'tasklist', ['/FI', `PID eq ${process.ppid}`, '/FO', 'CSV', '/NH'],
          { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toLowerCase();
      }
    } else {
      parentInfo = execFileSync(
        'ps', ['-p', String(process.ppid), '-o', 'command='],
        { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).toLowerCase();
    }

    // Order matters: "opencode" must be tested before "codex" so an opencode
    // parent is never mistaken for Codex on a substring match.
    for (const [needle, runtime] of PROCESS_TREE_MARKERS) {
      if (parentInfo.includes(needle)) {
        return { runtime, method: 'process-tree' };
      }
    }
  } catch {
    // Ignore and continue to directory markers.
  }

  const present = DIRECTORY_MARKERS
    .filter(([dir]) => fs.existsSync(path.join(root, dir)));

  if (present.length === 1) {
    return { runtime: present[0][1], method: 'directory-marker' };
  }
  if (present.length > 1) {
    try {
      // Most recently touched marker directory wins.
      const ranked = present
        .map(([dir, runtime]) => ({ runtime, mtimeMs: fs.statSync(path.join(root, dir)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { runtime: ranked[0].runtime, method: 'directory-marker-recency' };
    } catch {
      return { runtime: 'claude-code', method: 'directory-marker-fallback' };
    }
  }

  return { runtime: 'unknown', method: 'default' };
}

module.exports = Object.freeze({
  VALID_RUNTIMES,
  detectRuntime,
});
