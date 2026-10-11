#!/usr/bin/env node

'use strict';

const runtime = require('./runtime');
const hookInput = require('./adapters/hook-input');
const { installCopilotHooks } = require('./generators/install-hooks');

module.exports = Object.freeze({ runtime, hookInput, installCopilotHooks });
