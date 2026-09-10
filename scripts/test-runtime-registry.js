#!/usr/bin/env node

'use strict';

const path = require('path');
const { getRuntimeDefinition, listRuntimeIds } = require(path.join(__dirname, '..', 'core', 'runtime', 'registry'));
const { detectRuntime, VALID_RUNTIMES } = require(path.join(__dirname, '..', 'core', 'runtime', 'detect-runtime'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const runtimeIds = listRuntimeIds();
  for (const expected of ['claude-code', 'codex', 'opencode', 'unknown']) {
    if (!runtimeIds.includes(expected)) {
      fail(`Runtime registry missing expected runtime id: ${expected}`);
    }
  }

  for (const expected of ['codex', 'opencode']) {
    if (!VALID_RUNTIMES.includes(expected)) {
      fail(`Detect-runtime valid runtime list missing ${expected}`);
    }
  }

  const claude = getRuntimeDefinition('claude-code');
  const codex = getRuntimeDefinition('codex');
  const opencode = getRuntimeDefinition('opencode');
  const unknown = getRuntimeDefinition('does-not-exist');

  if (claude.id !== 'claude-code') fail('Claude runtime definition mismatch');
  if (codex.id !== 'codex') fail('Codex runtime definition mismatch');
  if (opencode.id !== 'opencode') fail('opencode runtime definition mismatch');
  if (unknown.id !== 'unknown') fail('Unknown runtime fallback mismatch');
  if (claude.capabilities.hooks.support !== 'full') fail('Claude runtime hooks capability mismatch');
  if (codex.capabilities.hooks.support === 'full') fail('Codex runtime hooks support should not be full');

  // opencode cannot block on Stop and has no native permission gate. Claiming
  // full hook support, or dropping those degradations, would misreport the
  // runtime to every consumer of the capability contract.
  if (opencode.capabilities.hooks.support !== 'partial') {
    fail('opencode runtime hooks support must be partial');
  }
  if (opencode.capabilities.guidance.support !== 'full' || opencode.capabilities.skills.support !== 'full') {
    fail('opencode runtime must report full guidance and skills support');
  }
  for (const degradation of ['stop-cannot-block', 'permission-gate-not-native']) {
    if (!opencode.degradations.includes(degradation)) {
      fail(`opencode runtime must declare the ${degradation} degradation`);
    }
  }

  const origEnv = process.env.CITADEL_RUNTIME;
  process.env.CITADEL_RUNTIME = 'codex';
  const detected = detectRuntime('/nonexistent');
  if (detected.runtime !== 'codex' || detected.method !== 'env') {
    fail(`Runtime detection env override mismatch: ${detected.runtime}/${detected.method}`);
  }
  if (origEnv !== undefined) process.env.CITADEL_RUNTIME = origEnv;
  else delete process.env.CITADEL_RUNTIME;


  // Exercise process probing and fallback without depending on host tooling.
  const assert = require('assert');
  const vm = require('vm');
  const source = require('fs').readFileSync(path.join(__dirname, '..', 'core', 'runtime', 'detect-runtime.js'), 'utf8');
  // Runs detect-runtime against a sandboxed host so the assertions never depend
  // on the real process tree or filesystem. `markers` are the directory names
  // existsSync should report as present; `mtimes` drives the recency tiebreak.
  function probe({ platform, probeFails, parentCommand, markers, mtimes = {} }) {
    const calls = [];
    const exported = { exports: {} };
    vm.runInNewContext(source, {
      module: exported,
      process: { platform, ppid: 4321, env: {}, cwd: () => '/project with spaces' },
      require: (name) => {
        if (name === './registry') return { listRuntimeIds };
        if (name === 'path') return path;
        if (name === 'fs') {
          return {
            existsSync: (target) => markers.some((marker) => target.endsWith(marker)),
            statSync: (target) => {
              const marker = markers.find((item) => target.endsWith(item));
              if (!marker) throw new Error(`unexpected statSync target: ${target}`);
              return { mtimeMs: mtimes[marker] ?? 0 };
            },
          };
        }
        if (name === 'child_process') return {
          execFileSync: (file, args, options) => {
            calls.push([file, Array.from(args)]);
            assert.notEqual(options.shell, true);
            if (probeFails || file === 'wmic') throw new Error('probe unavailable');
            return parentCommand;
          },
        };
        throw new Error('Unexpected dependency: ' + name);
      },
    });
    return { result: exported.exports.detectRuntime(), calls };
  }

  function expectedCalls(platform) {
    return platform === 'win32' ? [
      ['wmic', ['process', 'where', 'ProcessId=4321', 'get', 'CommandLine', '/format:list']],
      ['tasklist', ['/FI', 'PID eq 4321', '/FO', 'CSV', '/NH']],
    ] : [['ps', ['-p', '4321', '-o', 'command=']]];
  }

  for (const platform of ['win32', 'linux']) {
    for (const probeFails of [false, true]) {
      for (const [runtimeId, marker] of [['codex', '.codex'], ['opencode', '.opencode']]) {
        const { result, calls } = probe({
          platform,
          probeFails,
          parentCommand: runtimeId,
          markers: [marker],
        });
        assert.equal(result.runtime, runtimeId);
        assert.equal(result.method, probeFails ? 'directory-marker' : 'process-tree');
        assert.deepEqual(calls, expectedCalls(platform));
      }
    }
  }

  // An opencode parent must never be read as Codex on a substring match.
  assert.equal(
    probe({ platform: 'linux', probeFails: false, parentCommand: 'bun /home/u/.opencode/bin/opencode', markers: [] })
      .result.runtime,
    'opencode',
  );

  // Marker recency decides when a project carries more than one runtime dir,
  // and an equal-mtime tie still resolves to claude-code.
  assert.equal(
    probe({
      platform: 'linux',
      probeFails: true,
      parentCommand: '',
      markers: ['.claude', '.opencode'],
      mtimes: { '.claude': 10, '.opencode': 20 },
    }).result.runtime,
    'opencode',
  );
  const tie = probe({
    platform: 'linux',
    probeFails: true,
    parentCommand: '',
    markers: ['.claude', '.codex', '.opencode'],
    mtimes: { '.claude': 5, '.codex': 5, '.opencode': 5 },
  }).result;
  assert.equal(tie.runtime, 'claude-code');
  assert.equal(tie.method, 'directory-marker-recency');

  // No parent signal and no markers stays honest rather than guessing.
  assert.equal(
    probe({ platform: 'linux', probeFails: true, parentCommand: '', markers: [] }).result.method,
    'default',
  );

  console.log('Runtime registry tests pass.');
}

main();
