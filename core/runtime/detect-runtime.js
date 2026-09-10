#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { listRuntimeIds } = require('./registry');

const VALID_RUNTIMES = listRuntimeIds();

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

    if (parentInfo.includes('codex')) {
      return { runtime: 'codex', method: 'process-tree' };
    }
    if (parentInfo.includes('claude')) {
      return { runtime: 'claude-code', method: 'process-tree' };
    }
  } catch {
    // Ignore and continue to directory markers.
  }

  const hasClaudeDir = fs.existsSync(path.join(root, '.claude'));
  const hasCodexDir = fs.existsSync(path.join(root, '.codex'));

  if (hasCodexDir && !hasClaudeDir) {
    return { runtime: 'codex', method: 'directory-marker' };
  }
  if (hasClaudeDir && !hasCodexDir) {
    return { runtime: 'claude-code', method: 'directory-marker' };
  }
  if (hasClaudeDir && hasCodexDir) {
    try {
      const claudeStat = fs.statSync(path.join(root, '.claude'));
      const codexStat = fs.statSync(path.join(root, '.codex'));
      const runtime = codexStat.mtimeMs > claudeStat.mtimeMs ? 'codex' : 'claude-code';
      return { runtime, method: 'directory-marker-recency' };
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
