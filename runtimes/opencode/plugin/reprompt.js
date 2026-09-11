#!/usr/bin/env node

'use strict';

// Restores something close to Stop-blocking on opencode, for projects that ask
// for it.
//
// opencode dispatches bus events fire-and-forget, so `session.idle` cannot refuse
// to end a turn. Deferred injection (pending-notices.js) gets the finding to the
// model, but only when a human types the next prompt. Re-prompting closes that
// gap: on an idle that carried a finding, the plugin asks opencode for one more
// turn, and the finding rides into it through the normal chat.message injection.
//
// This drives real model turns and spends real tokens without a human asking, so
// it is **off unless a project turns it on**, and it is bounded by two guards
// that matter more than the feature does:
//
//   1. A per-session cap. Once spent, that session never re-prompts again.
//   2. Never re-prompt a re-prompt. The idle produced by our own turn is skipped,
//      so the plugin can never answer itself in a cycle.
//
// The guards are deliberately pessimistic: a slot is spent at the moment of the
// decision, not on a confirmed send, so a failed send costs a re-prompt rather
// than risking an extra one.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_PER_SESSION = 2;
// A ceiling no config can raise. The cap exists to bound autonomous spending, so
// it must not be possible to configure it away.
const HARD_MAX_PER_SESSION = 5;

const REPROMPT_TEXT = [
  '[Citadel] The previous turn ended with unresolved quality-gate findings.',
  'opencode cannot block on the stop event, so this turn was started to carry them',
  'back to you. Address the findings below, or say why they do not apply.',
].join('\n');

/**
 * Read the re-prompt policy from the project's harness config. Absent, malformed
 * or unreadable config all mean disabled: this feature must never switch itself
 * on by accident.
 */
function readConfig(projectRoot) {
  const disabled = { enabled: false, maxPerSession: DEFAULT_MAX_PER_SESSION };
  let raw;
  try {
    const file = path.join(projectRoot, '.claude', 'harness.json');
    if (!fs.existsSync(file)) return disabled;
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return disabled;
  }
  const block = raw && typeof raw === 'object' ? raw.opencode : null;
  if (!block || typeof block !== 'object') return disabled;
  if (block.repromptOnStopFindings !== true) return disabled;

  let maxPerSession = DEFAULT_MAX_PER_SESSION;
  const configured = block.maxRepromptsPerSession;
  if (Number.isInteger(configured) && configured > 0) {
    maxPerSession = Math.min(configured, HARD_MAX_PER_SESSION);
  }
  return { enabled: true, maxPerSession };
}

/**
 * The decision half, kept free of I/O so the loop guard is testable without a
 * live opencode. State is per plugin instance, which is per opencode process:
 * a restart resets the counts, and a restart is a new server anyway.
 */
function createGuard(config) {
  const policy = config || { enabled: false, maxPerSession: DEFAULT_MAX_PER_SESSION };
  const sessions = new Map();

  return {
    /**
     * Called for **every** session.idle, with `hasFinding` saying whether this
     * one carried anything worth re-prompting about.
     *
     * Quiet idles matter as much as loud ones: the mark that stops us answering
     * our own turn has to be consumed by whichever idle our turn produced, and a
     * re-prompt that works ends with the model having *fixed* the finding, so
     * that idle is silent. Consuming the mark only on findings leaves it set,
     * and it then eats the next legitimate re-prompt instead. Observed live.
     */
    consider(sessionID, hasFinding) {
      if (!policy.enabled) return { send: false, reason: 'disabled' };
      if (typeof sessionID !== 'string' || !sessionID) return { send: false, reason: 'no-session-id' };

      const state = sessions.get(sessionID) || { sent: 0, skipNext: false };

      // This idle is the one our own re-prompt produced. Consume the mark and
      // decline: answering it is precisely the loop this guard exists to stop.
      if (state.skipNext) {
        state.skipNext = false;
        sessions.set(sessionID, state);
        return { send: false, reason: 'idle-follows-reprompt' };
      }

      if (!hasFinding) return { send: false, reason: 'no-finding' };
      if (state.sent >= policy.maxPerSession) return { send: false, reason: 'cap-reached' };

      state.sent += 1;
      state.skipNext = true;
      sessions.set(sessionID, state);
      return { send: true, reason: 'ok', sent: state.sent, cap: policy.maxPerSession };
    },

    stats(sessionID) {
      const state = sessions.get(sessionID);
      return { sent: state ? state.sent : 0, skipNext: state ? state.skipNext : false };
    },
  };
}

module.exports = Object.freeze({
  DEFAULT_MAX_PER_SESSION,
  HARD_MAX_PER_SESSION,
  REPROMPT_TEXT,
  createGuard,
  readConfig,
});
