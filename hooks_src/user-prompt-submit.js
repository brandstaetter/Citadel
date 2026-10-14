#!/usr/bin/env node

/**
 * user-prompt-submit.js — UserPromptSubmit hook
 *
 * Fires before Claude processes each user prompt. This is the earliest
 * interception point in the turn lifecycle — hooks here can block or
 * modify the prompt before Claude sees it.
 *
 * Current behavior: observe-only logging. Records the session boundary
 * for turn attribution in telemetry. Future extension point for
 * semantic prompt screening (type: "prompt" gate) if needed.
 *
 * Design:
 *   - Observer only: always exit 0 (never blocks prompts)
 *   - Privacy: logs session_id and turn count, not prompt content
 *   - Lightweight: <5ms budget (fires on every user turn)
 *
 * Exit codes:
 *   0 = always (observer)
 */

'use strict';

const health = require('./harness-health-util');

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let event = {};
    try { event = JSON.parse(input); } catch { /* partial input ok */ }

    const sessionId = event.session_id || null;
    const agentId = event.agent_id || null;

    health.increment('user-prompt-submit', 'count');

    health.logTiming('user-prompt-submit', 0, {
      event: 'prompt-submitted',
      session_id: sessionId,
      agent_id: agentId,
    });

    const prompt = event.original_prompt || event.prompt || '';
    const match = String(prompt).trim().match(/^([/$])((?:[a-z][a-z0-9-]*:)?[a-z][a-z0-9-]*)/i);
    if (match) {
      const invocation = `${match[1]}${match[2]}`;
      const skillName = match[2].toLowerCase().split(':').pop();
      const activation = health.checkSkillActivation(skillName);
      const decision = activation.decision;
      if (!['enabled', 'degraded'].includes(decision.status)
        && decision.reasonCode !== 'ACTIVATION_OWNERSHIP_UNKNOWN') {
        const apply = decision.plan?.applyCommand
          ? ` Review and explicitly apply: ${decision.plan.applyCommand}`
          : '';
        health.logBlock(
          'user-prompt-submit',
          'bundle-blocked',
          `${skillName}:${decision.reasonCode}`,
          { runtime: activation.runtime, sourceDigest: activation.effective.sourceDigest },
        );
        process.stderr.write(
          `[Citadel activation] ${invocation} is ${decision.status} `
          + `(${decision.reasonCode}).${apply}\n`,
        );
        process.exit(2);
        return;
      }
    }

    process.exit(0);
  });
}

main();
