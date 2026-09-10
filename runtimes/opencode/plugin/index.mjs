// Citadel plugin for opencode.
//
// opencode loads this module in-process (under Bun) and calls the hooks it
// returns as (input, output) => Promise<void>. Two opencode behaviors drive the
// whole shape of this file:
//
//   Blocking is `throw`. A rejection from tool.execute.before fails just that
//   tool call, with the thrown message reaching the model as the tool result.
//
//   Mutation is in place. session/tools.ts passes the original `args` object to
//   the tool, not `output.args`, so assigning `output.args = {...}` is silently
//   discarded while `output.args.command = '...'` is honored.
//
// The real work lives in hook-runner.js (CommonJS) so Citadel's own test suite
// can exercise it under plain Node without Bun or opencode installed.
//
// Known limitation: if this module fails to load, opencode reports a plugin
// error and continues with no Citadel gating at all. That fail-open is opencode's
// behavior, not something the plugin can prevent, so the module keeps its load
// path as small as possible and does no work at import time.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('./hook-runner.js');

function blockedError(outcome) {
  const error = new Error(outcome.reason || '[citadel] blocked by a Citadel hook');
  error.name = 'CitadelBlockedError';
  return error;
}

async function observe(event, payload, options) {
  try {
    return await runner.runHooksForEvent(event, payload, options);
  } catch (error) {
    // An observer must never break the session. Swallow and carry on; opencode
    // would otherwise surface this as a plugin error on every turn.
    return { event, blocked: false, reason: null, messages: [], results: [], skipped: [{ hook: null, reason: error.message }] };
  }
}

export const CitadelPlugin = async ({ project, directory, worktree, client } = {}) => {
  const projectRoot = worktree || directory || project?.worktree || process.cwd();
  const options = { projectRoot };

  async function log(level, message, extra) {
    try {
      await client?.app?.log({ body: { service: 'citadel', level, message, extra } });
    } catch { /* logging must never break a turn */ }
  }

  // The plugin's init function is the only thing opencode runs once per project
  // directory before any turn, so it stands in for SessionStart.
  const start = await observe('plugin.init', { directory: projectRoot }, options);
  if (start.messages.length) await log('info', 'citadel session start', { messages: start.messages });

  return {
    async 'tool.execute.before'(input, output) {
      const outcome = await runner.runHooksForEvent('tool.execute.before', {
        ...input,
        args: output.args,
        directory: projectRoot,
      }, options);

      if (outcome.blocked) throw blockedError(outcome);
    },

    async 'tool.execute.after'(input, output) {
      const outcome = await observe('tool.execute.after', {
        ...input,
        args: input.args,
        directory: projectRoot,
      }, options);

      // Never throw here: the tool already ran, and rejecting would report a
      // successful call as failed. Append findings to the output the model sees.
      if (outcome.messages.length && typeof output.output === 'string') {
        output.output = `${output.output}\n\n${outcome.messages.join('\n')}`;
      }
    },

    async 'chat.message'(input, output) {
      const outcome = await observe('chat.message', { ...input, directory: projectRoot }, options);
      if (!outcome.messages.length) return;

      // Pushing onto the existing parts array injects context; replacing
      // output.parts would be discarded, because prompt.ts keeps iterating the
      // array it handed in.
      if (Array.isArray(output.parts)) {
        output.parts.push({ type: 'text', text: outcome.messages.join('\n') });
      }
    },

    async config(config) {
      await observe('config', { directory: projectRoot, config }, options);
    },

    // opencode dispatches bus events fire-and-forget, so everything here is
    // observation only. Notably session.idle cannot block the way a Claude Code
    // Stop hook can.
    async event({ event }) {
      if (!event?.type) return;
      if (!runner.TEMPLATE_EVENT_BY_OPENCODE_EVENT[event.type]) return;
      const outcome = await observe(event.type, {
        ...(event.properties || {}),
        directory: projectRoot,
      }, options);
      if (outcome.messages.length) await log('info', `citadel ${event.type}`, { messages: outcome.messages });
    },

    async dispose() {
      await observe('dispose', { directory: projectRoot }, options);
    },
  };
};

export default CitadelPlugin;
