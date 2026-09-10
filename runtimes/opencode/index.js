#!/usr/bin/env node

'use strict';

const runtime = require('./runtime');

// Generators, the hook-input adapter, and the plugin itself land in later
// phases. This barrel intentionally exports only what exists so the registry
// can resolve the runtime today.
module.exports = Object.freeze({
  runtime,
});
