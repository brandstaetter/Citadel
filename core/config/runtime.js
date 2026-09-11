'use strict';

const fs = require('fs');
const path = require('path');

const UNKNOWN_LOCAL_RUNTIME = Object.freeze({
  id: 'local-unknown',
  displayName: 'Local runtime (not selected)',
  capabilities: Object.freeze({
    workspace: Object.freeze({
      support: 'full',
      notes: 'The local filesystem is available, but no agent runtime was selected.',
    }),
  }),
  degradations: Object.freeze(['runtime-not-selected']),
});

function normalizeRuntimeId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'claude') return 'claude-code';
  if (id === 'responses' || id === 'responses-api') return 'openai';
  return id;
}

function runtimeContract(runtimeId) {
  const id = normalizeRuntimeId(runtimeId);
  if (id === 'codex') return require('../../runtimes/codex/runtime');
  if (id === 'opencode') return require('../../runtimes/opencode/runtime');
  if (id === 'claude-code') return require('../../runtimes/claude-code/runtime');
  if (id === 'openai') return require('../../runtimes/openai/runtime');
  return UNKNOWN_LOCAL_RUNTIME;
}

// Marker directory per local runtime. Exactly one match is a confident answer;
// zero or several stay unknown rather than guessing, which is why this does not
// share core/runtime/detect-runtime.js's recency tiebreak.
const LOCAL_RUNTIME_MARKERS = Object.freeze([
  ['.claude', 'claude-code'],
  ['.codex', 'codex'],
  ['.opencode', 'opencode'],
]);

function detectRuntimeContract(projectRoot, options = {}) {
  if (options.runtime && typeof options.runtime === 'object') return options.runtime;
  const explicit = options.runtimeId
    || options.env?.CITADEL_RUNTIME
    || process.env.CITADEL_RUNTIME;
  if (explicit) return runtimeContract(explicit);

  const root = path.resolve(projectRoot || process.cwd());
  const present = LOCAL_RUNTIME_MARKERS.filter(([dir]) => fs.existsSync(path.join(root, dir)));
  if (present.length === 1) return runtimeContract(present[0][1]);
  return UNKNOWN_LOCAL_RUNTIME;
}

module.exports = Object.freeze({
  UNKNOWN_LOCAL_RUNTIME,
  detectRuntimeContract,
  normalizeRuntimeId,
  runtimeContract,
});
