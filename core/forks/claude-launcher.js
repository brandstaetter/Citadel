'use strict';

const childProcess = require('child_process');
const { platformInvocation } = require('./launcher');

const CLAUDE_BIN = process.env.CITADEL_CLAUDE_BIN || 'claude';

// Use the same shell-free Windows shim handling as ordinary fork execution.
// An explicit executable override is never replaced by an unrelated fallback.
function spawnClaudeSync(args, options = {}) {
  const invocation = platformInvocation({ command: CLAUDE_BIN, args }, { env: options.env });
  return childProcess.spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

module.exports = Object.freeze({ CLAUDE_BIN, spawnClaudeSync });
