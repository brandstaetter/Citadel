#!/usr/bin/env node

'use strict';

// Every hardcoded runtime-valued list in core/, and what it promises about the
// runtime registry.
//
// This exists because adding a runtime to the registry does not add it anywhere
// else. `opencode` was registered, detected, installed and shipped while
// `core/telemetry/activation.js` still accepted only claude-code and codex, so
// every opencode install threw validation, `install.js`'s recordSafely swallowed
// it into `recorded: false`, and opencode was absent from activation metrics with
// no error surfaced anywhere. That was found by review, not by a test, and it was
// one instance of an unguarded pattern rather than a typo.
//
// The rule is not "every list must contain every runtime" -- several of these
// lists are legitimately narrower. The rule is that every list must be declared
// here and must say, in writing, which runtimes it omits and why.
// `scripts/test-runtime-registry.js` enforces both halves: the coverage each
// entry claims, and that no undeclared runtime list exists in core/.

const path = require('path');

const CORE_DIR = path.join(__dirname, '..');

// `unknown` is the registry's not-detected sentinel, not a runtime anyone
// integrates against, so no downstream list is expected to carry it.
const SENTINEL_RUNTIME = 'unknown';

// Some lists predate the `claude-code` id and spell it `claude`. That is a naming
// difference, not a coverage gap, so coverage is compared through this map.
const SHORT_NAME_BY_ID = Object.freeze({
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
});

/**
 * kind:
 *   'agent-runtime' — the field names a Citadel runtime, so registry coverage
 *                     applies and every omission needs a reason.
 *   'other-axis'    — the field is called runtime but means something else
 *                     (an execution environment, say). Coverage does not apply;
 *                     the entry still has to exist and justify itself.
 */
const RUNTIME_LISTS = Object.freeze([
  {
    module: 'telemetry/activation.js',
    exportName: 'RUNTIMES',
    kind: 'agent-runtime',
    naming: 'id',
    note: 'Activation events. scripts/install.js normalizeRuntime() emits these ids directly.',
    exclusions: {},
  },
  {
    module: 'packs/manifest.js',
    exportName: 'RUNTIMES',
    kind: 'agent-runtime',
    naming: 'id',
    note: 'Runtimes a pack may declare support for.',
    exclusions: {},
  },
  {
    module: 'golden-path/matrix.js',
    exportName: 'RUNTIMES',
    kind: 'agent-runtime',
    naming: 'short',
    note: 'Platform x runtime evidence grid.',
    exclusions: {
      opencode:
        'The matrix iterates these to build cells and calls the grid complete only at >=5 real runs '
        + 'per platform per runtime. Listing opencode would assert evidence that has not been collected. '
        + 'Unblocked by running the golden-path fixture on opencode across win32/linux/darwin.',
    },
  },
  {
    module: 'optimizer/contracts.js',
    exportName: 'RUNTIMES',
    kind: 'agent-runtime',
    naming: 'short',
    note: 'Optimizer runtime assignment.',
    exclusions: {
      opencode:
        'Part of the frozen optimizer request contract verified by scripts/test-optimizer.js. Widening the '
        + 'accepted set changes what committed evidence would have validated against. Needs a contract '
        + 'revision, not an enum edit.',
    },
  },
  {
    module: 'forks/contracts.js',
    exportName: 'RUNTIMES',
    kind: 'agent-runtime',
    naming: 'short',
    note: 'Runtimes a parallel fork branch may execute under.',
    exclusions: {
      opencode:
        'Citadel spawns fork executors itself and there is no opencode launcher — core/forks ships '
        + 'claude-launcher.js only. Listing it would accept branches that cannot be run.',
    },
  },
  {
    module: 'forks/executor-profiles.js',
    exportName: 'EXECUTOR_RUNTIMES',
    kind: 'agent-runtime',
    naming: 'short',
    note: 'Executor profiles, including per-runtime adapter_options.',
    exclusions: {
      opencode:
        'Same missing launcher as forks/contracts.js, and adapter_options are validated per runtime with '
        + 'no opencode option set defined.',
    },
  },
  {
    module: 'product-proof/trial-contract.js',
    exportName: 'RUNTIMES',
    kind: 'agent-runtime',
    naming: 'id',
    note: 'runtime_family used to stratify trial assignments.',
    exclusions: {
      opencode:
        'This is a stratification family, not a runtime id, and the list carries an "other" bucket that '
        + 'opencode trials fall into today. Promoting it to its own family would change the strata that '
        + 'committed trial evidence was assigned under.',
    },
  },
  {
    module: 'reliability/schema.js',
    exportName: 'RUNTIMES',
    kind: 'other-axis',
    naming: 'id',
    note:
      'Despite the name this is the execution environment a reliability record came from — the list also '
      + 'holds github-actions and local, which are not agent runtimes. Registry coverage does not apply.',
    exclusions: {},
  },
]);

function modulePath(entry) {
  return path.join(CORE_DIR, entry.module);
}

/** The runtimes a downstream list is expected to know about. */
function coveredRuntimes(registryIds) {
  return registryIds.filter((id) => id !== SENTINEL_RUNTIME);
}

/** Spell a registry id the way the given list spells it. */
function nameFor(runtimeId, naming) {
  if (naming === 'short') return SHORT_NAME_BY_ID[runtimeId] || runtimeId;
  return runtimeId;
}

module.exports = Object.freeze({
  CORE_DIR,
  RUNTIME_LISTS,
  SENTINEL_RUNTIME,
  SHORT_NAME_BY_ID,
  coveredRuntimes,
  modulePath,
  nameFor,
});
