#!/usr/bin/env node
'use strict';

const path = require('path');
const { generateShorthands } = require('../core/skills/codex-shorthands');

try {
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1] && !args[i + 1].startsWith('--')) projectRoot = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  console.log(JSON.stringify(generateShorthands({
    projectRoot, citadelRoot: path.resolve(__dirname, '..'), dryRun,
  }), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
