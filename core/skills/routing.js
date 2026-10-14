'use strict';

const fs = require('fs');
const path = require('path');

// Exact commands are the only requests that may resolve without semantic
// classification. Keep this data-only so the same contract can be generated
// into the browser demo and the /do skill documentation.
const DETERMINISTIC_COMMANDS = Object.freeze([
  Object.freeze({
    id: 'status',
    phrases: Object.freeze(['status', 'dashboard', "what's happening", "what's going on", 'show activity']),
    selected: '/dashboard',
    command: 'node scripts/dashboard.js',
    reason: 'an exact status command maps to the dashboard.',
    verification: 'Confirm the dashboard renders the expected pending counts and next action.',
  }),
  Object.freeze({
    id: 'next',
    phrases: Object.freeze(['next', 'what should i do next', 'fix harness state', 'repair harness']),
    selected: '/do next',
    command: 'node scripts/operator-console.js --run',
    reason: 'an exact next-action command maps to the deterministic operator console.',
    verification: 'Confirm the operator report reaches idle or an explicit approval boundary.',
  }),
  Object.freeze({
    id: 'operator',
    phrases: Object.freeze(['operator', 'operator console', 'approval capsule', "what's up", 'what should happen next']),
    selected: '/do operator',
    command: 'node scripts/operator-console.js',
    reason: 'an exact operator command asks for the inspect-only cockpit.',
    verification: 'Confirm the report names the next action, boundary, risk, and verification profile.',
  }),
  Object.freeze({
    id: 'continue',
    phrases: Object.freeze(['continue', 'keep going']),
    selected: '/do continue',
    command: 'node scripts/continue-action.js --run',
    reason: 'an exact continuation command resumes active campaign or fleet state.',
    verification: 'Confirm the continuation report either resumes work or says no active work exists.',
  }),
  Object.freeze({
    id: 'setup',
    phrases: Object.freeze(['setup', 'first run', 'configure harness']),
    selected: '/setup',
    command: '/do setup',
    reason: 'an exact setup command opens the first-run experience.',
    verification: 'Run the dashboard and confirm `.planning/` exists for the current project.',
  }),
  Object.freeze({
    id: 'setup-express',
    phrases: Object.freeze(['setup --express']),
    selected: '/setup',
    command: '/do setup --express',
    reason: 'the exact express setup command selects the zero-question setup mode.',
    verification: 'Run the dashboard and confirm `.planning/` exists for the current project.',
  }),
  Object.freeze({
    id: 'list',
    phrases: Object.freeze(['--list', 'list', 'list skills']),
    selected: '/do --list',
    command: '/do --list',
    reason: 'an exact list command shows the installed routing catalog.',
    verification: 'Confirm the installed skills and trigger summaries render.',
  }),
  Object.freeze({
    id: 'test',
    phrases: Object.freeze(['test', 'tests', 'run test', 'run tests']),
    selected: null,
    command: null,
    projectScript: 'test',
    reason: 'an exact test command may use the target project test script when that capability is declared.',
    verification: 'Confirm the command exits 0 or reports actionable failures.',
  }),
  Object.freeze({
    id: 'build',
    phrases: Object.freeze(['build', 'run build']),
    selected: null,
    command: null,
    projectScript: 'build',
    reason: 'an exact build command may use the target project build script when that capability is declared.',
    verification: 'Confirm the command exits 0 or reports actionable failures.',
  }),
  Object.freeze({
    id: 'typecheck',
    phrases: Object.freeze(['typecheck', 'type check', 'run typecheck', 'run type check']),
    selected: null,
    command: null,
    projectScript: 'typecheck',
    reason: 'an exact typecheck command may use the target project typecheck script when that capability is declared.',
    verification: 'Confirm the command exits 0 or reports actionable type errors.',
  }),
]);

const ROUTE_LABELS = Object.freeze({ fleet: '/fleet --quick' });

function normalizeRoutingInput(value) {
  return String(value || '')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function stripDoPrefix(value) {
  return String(value || '').trim().replace(/^(?:\/(?:citadel:)?do|\$citadel:do)(?:\s+|$)/i, '').trim();
}

function parseRequestEnvelope(value, options = {}) {
  const originalInput = String(value || '').trim();
  let request = stripDoPrefix(originalInput);
  let mode = options.mode === 'preview' ? 'preview' : 'execute';
  const previewMatch = request.match(/^preview(?:\s+|$)([\s\S]*)$/i);
  if (previewMatch) {
    mode = 'preview';
    request = previewMatch[1].trim();
  }
  return { mode, originalInput, request };
}

function parseDeterministicCommand(value) {
  const normalized = normalizeRoutingInput(stripDoPrefix(value));
  if (!normalized) return null;
  return DETERMINISTIC_COMMANDS.find((entry) => entry.phrases.includes(normalized)) || null;
}

function readPackageScripts(projectRoot) {
  try {
    const packagePath = path.join(path.resolve(projectRoot || process.cwd()), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return parsed && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
      ? parsed.scripts
      : {};
  } catch (_error) {
    return {};
  }
}

function resolveDeterministicCommand(entry, projectRoot) {
  if (!entry) return null;
  if (!entry.projectScript) {
    return {
      ...entry,
      final: true,
      capability: null,
    };
  }

  const scripts = readPackageScripts(projectRoot);
  const declared = Object.prototype.hasOwnProperty.call(scripts, entry.projectScript)
    && typeof scripts[entry.projectScript] === 'string'
    && scripts[entry.projectScript].trim().length > 0;
  const capability = {
    verified: declared,
    kind: 'package-script',
    name: entry.projectScript,
    source: `package.json#scripts.${entry.projectScript}`,
  };

  if (!declared) {
    return {
      ...entry,
      selected: null,
      command: null,
      final: false,
      capability,
      reason: `${entry.reason} The target project does not declare ${capability.source}, so this preview is non-executable.`,
    };
  }

  return {
    ...entry,
    selected: 'direct-command',
    command: `npm run ${entry.projectScript}`,
    final: true,
    capability,
    reason: `${entry.reason} ${capability.source} was verified in the target project.`,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(input, keyword) {
  const needle = normalizeRoutingInput(keyword);
  return new RegExp(`(?:^|[^\\w])${escapeRegExp(needle)}(?=$|[^\\w])`, 'i').test(input);
}

function routeForSkill(name) {
  return ROUTE_LABELS[name] || `/${name}`;
}

function collectSkillCandidates(input, skills) {
  return skills
    .map((entry) => ({
      ...entry,
      route: entry.route || routeForSkill(entry.name),
      matches: entry.keywords.filter((keyword) => matchesKeyword(input, keyword)),
    }))
    .filter((entry) => entry.matches.length > 0)
    .sort((a, b) => b.matches.length - a.matches.length || a.keywords.length - b.keywords.length || a.name.localeCompare(b.name));
}

function validateRouteOverride(value, skills) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const requested = normalizeRoutingInput(value);
  for (const skill of skills) {
    const canonical = `/${skill.name}`;
    const selected = skill.route || routeForSkill(skill.name);
    if (requested === normalizeRoutingInput(canonical) || requested === normalizeRoutingInput(selected)) {
      return selected;
    }
  }
  throw new Error(`Unknown route override: ${value}`);
}

module.exports = Object.freeze({
  DETERMINISTIC_COMMANDS,
  ROUTE_LABELS,
  collectSkillCandidates,
  matchesKeyword,
  normalizeRoutingInput,
  parseDeterministicCommand,
  parseRequestEnvelope,
  resolveDeterministicCommand,
  routeForSkill,
  stripDoPrefix,
  validateRouteOverride,
});
