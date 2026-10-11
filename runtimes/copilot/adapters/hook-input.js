#!/usr/bin/env node

'use strict';

const path = require('path');
const { createEnvelope } = require(path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'normalize-event'));

function normalizeCopilotHookInput(payload, configuredEventName = null) {
  const nativeEventName = payload.hook_event_name || payload.event_name || configuredEventName;
  return createEnvelope('copilot', nativeEventName, payload);
}

module.exports = Object.freeze({
  normalizeCopilotHookInput,
});
