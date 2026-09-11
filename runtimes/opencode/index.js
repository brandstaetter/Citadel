#!/usr/bin/env node

'use strict';

const path = require('path');
const runtime = require('./runtime');
const hookInput = require('./adapters/hook-input');
const hookRunner = require('./plugin/hook-runner');

// The plugin opencode loads is ESM (it runs in Bun), so it is exposed as a path
// rather than required here. Generators and the installer land in phase 4.
const PLUGIN_ENTRY = path.join(__dirname, 'plugin', 'index.mjs');

module.exports = Object.freeze({
  runtime,
  hookInput,
  hookRunner,
  PLUGIN_ENTRY,
});
