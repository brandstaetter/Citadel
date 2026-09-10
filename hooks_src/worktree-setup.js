#!/usr/bin/env node

/**
 * worktree-setup.js — WorktreeCreate hook
 *
 * Auto-initializes new git worktrees for parallel agent execution.
 * Reports missing dependencies and environment files without installing
 * packages or copying secrets. Setup actions require normal tool approval.
 *
 * Receives stdin JSON: { "name": "agent-abc123", "path": "/path/to/worktree" }
 *
 * Exit codes:
 *   0 = setup complete (or skipped gracefully)
 *   2 = setup failed (blocks worktree creation)
 */

const path = require('path');
const health = require('./harness-health-util');
const { checkWorktreeReadiness } = require('../core/worktree/readiness');

const MAIN_ROOT = health.PROJECT_ROOT;

async function main(input) {
  const worktreePath = input.path;
  if (!worktreePath) return;

  const pathCheck = health.validatePath(worktreePath);
  if (!pathCheck.safe) {
    health.securityWarning('worktree-setup', `Possible injection in worktree path — ${pathCheck.violation}. Skipping setup.`);
    return;
  }

  // Readiness only. Tracked manifests and ignored env files are not consent
  // to execute lifecycle scripts or distribute secrets to another checkout.

  try {
    const report = await checkWorktreeReadiness({
      projectRoot: MAIN_ROOT,
      worktreePath,
      branch: input.branch || null,
      write: true,
    });
    health.logTiming('worktree-readiness', 0, {
      event: 'worktree-readiness',
      status: report.status,
      branch: input.branch || null,
      worktree: path.basename(worktreePath),
    });
    health.writeAuditLog('worktree-readiness', {
      status: report.status,
      blockFleet: report.blockFleet,
      branch: input.branch || null,
      worktree: path.basename(worktreePath),
      report: report.file,
    });
  } catch (err) {
    process.stderr.write(`[worktree-setup] Readiness check failed in ${worktreePath}: ${err.message}\n`);
  }
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
  try { await main(JSON.parse(data)); } catch { /* silent */ }
  process.stdout.write('ok\n');
});
