#!/usr/bin/env node

'use strict';

const runtime = require('./runtime');
const hookInput = require('./adapters/hook-input');

// Generators and the plugin itself land in later phases. This barrel
// intentionally exports only what exists so the registry can resolve the
// runtime today.
module.exports = Object.freeze({
  runtime,
  hookInput,
});
