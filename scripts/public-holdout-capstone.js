'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { digest } = require('../core/operation-control/contracts');
const { generateAttestationKeyPair } = require('../core/operation-control/receipt');
const { buildPool, DATASET, fetchSplit, validatePool, visibleTask } = require('../core/public-holdout/dataset');
const { buildSelectionRecord, createSelectionRequest, validateSelectionRecord } = require('../core/public-holdout/selection');
const { PLAN_IDS } = require('../core/public-holdout/router');
const { doctor, generateAttempt } = require('../core/public-holdout/runner');
const { buildAnalysis, buildAssignment, buildPreflight, buildPredictionEvidence, buildRouteLedger, buildVerdictBundle, buildVisibleArtifact, signAttempt, verifyAttestation } = require('../core/public-holdout/artifacts');

const ROOT = path.resolve(__dirname, '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'public-holdout-capstone');
const POOL_FILE = path.join(BENCHMARK, 'candidate-pool.json');
const REQUEST_FILE = path.join(BENCHMARK, 'selection-request.json');
const SELECTION_FILE = path.join(BENCHMARK, 'selection.json');
const VISIBLE_FILE = path.join(BENCHMARK, 'visible-tasks.json');
const PREFLIGHT_FILE = path.join(BENCHMARK, 'gold-preflight.json');
const ASSIGNMENT_FILE = path.join(BENCHMARK, 'assignment.json');
const ROUTE_LEDGER_FILE = path.join(BENCHMARK, 'route-ledger.json');
const ANALYSIS_FILE = path.join(BENCHMARK, 'final-analysis.json');
const KEY_FILE = process.env.CITADEL_HOLDOUT_KEY || path.join('C:\\tmp', 'citadel-public-holdout-ed25519.pem');
const PHASES = Object.freeze(['calibration', 'evaluation']);
const PLANS = Object.freeze(Object.values(PLAN_IDS));
const SOURCE_FILES = Object.freeze([
  '.github/workflows/public-holdout-evaluation.yml',
  'benchmarks/public-holdout-capstone/METHOD.md',
  'benchmarks/public-holdout-capstone/RESEARCH.md',
  'core/operation-control/contracts.js',
  'core/operation-control/receipt.js',
  'core/operation-controller/contracts.js',
  'core/operation-controller/controller.js',
  'core/public-holdout/dataset.js',
  'core/public-holdout/artifacts.js',
  'core/public-holdout/retrieval.js',
  'core/public-holdout/router.js',
  'core/forks/claude-launcher.js', 'core/forks/launcher.js', 'core/public-holdout/runner.js',
  'core/public-holdout/selection.js',
  'core/public-holdout/statistics.js',
  'scripts/public-holdout-capstone.js',
  'scripts/public-holdout-evaluator-summary.js',
  'scripts/public-holdout-matrix.js',
  'scripts/test-public-holdout-capstone.js',
  'package.json',
]);

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function normalizedSource(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n'); }
function sourceDigests() { return Object.fromEntries(SOURCE_FILES.map((relative) => [relative, digest(normalizedSource(relative))])); }
function privateKey() { return fs.readFileSync(KEY_FILE, 'utf8'); }
function publicKey() { return crypto.createPublicKey(privateKey()).export({ type: 'spki', format: 'pem' }); }
function attemptFile(phase, planId, instanceId) { return path.join(BENCHMARK, 'attempts', phase, planId, `${instanceId}.json`); }
function contextFile(instanceId) { return path.join(BENCHMARK, 'contexts', `${instanceId}.json`); }
function predictionFile(phase, planId) { return path.join(BENCHMARK, 'predictions', `${phase}--${planId}.json`); }
function predictionEvidenceFile(phase, planId) { return path.join(BENCHMARK, 'predictions', `${phase}--${planId}.evidence.json`); }
function verdictFile(phase, planId) { return path.join(BENCHMARK, 'verdicts', `${phase}--${planId}.json`); }

function createKey() {
  if (fs.existsSync(KEY_FILE)) throw new Error(`attestation key already exists: ${KEY_FILE}`);
  const pair = generateAttestationKeyPair(); fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true }); fs.writeFileSync(KEY_FILE, pair.private_key, { encoding: 'utf8', mode: 0o600 });
  return { status: 'created', key_file: KEY_FILE, public_key: pair.public_key };
}

async function buildCandidatePool() {
  const splitRows = {};
  for (const split of DATASET.splits) {
    process.stdout.write(`Fetching ${DATASET.id}/${split}...\n`);
    splitRows[split] = await fetchSplit(split);
  }
  const pool = buildPool(splitRows);
  writeJson(POOL_FILE, pool);
  return pool;
}

function buildRequest(roundText, roundTime) {
  const pool = validatePool(readJson(POOL_FILE));
  const supersedesRequestId = fs.existsSync(REQUEST_FILE) ? readJson(REQUEST_FILE).request_id : null;
  const request = createSelectionRequest({ pool, round: Number(roundText), roundTime, sourceDigests: sourceDigests(), attestationPublicKey: publicKey(), supersedesRequestId });
  writeJson(REQUEST_FILE, request);
  return request;
}

async function fetchRelay(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'citadel-public-holdout/1' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${sourceUrl}`);
  return { source_url: sourceUrl, beacon: await response.json() };
}

async function select() {
  const pool = validatePool(readJson(POOL_FILE));
  const request = readJson(REQUEST_FILE);
  const relays = [];
  for (const sourceUrl of request.beacon.source_urls) relays.push(await fetchRelay(sourceUrl));
  const selection = buildSelectionRecord({ request, pool, relayResponses: relays });
  writeJson(SELECTION_FILE, selection);
  return selection;
}

async function fetchRow(candidate) {
  const query = new URLSearchParams({ dataset: DATASET.id, config: DATASET.config, split: candidate.split, offset: String(candidate.row_index), length: '1' });
  const response = await fetch(`${DATASET.rows_api}?${query}`, { headers: { 'user-agent': 'citadel-public-holdout/1' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} hydrating ${candidate.instance_id}`);
  const page = await response.json();
  if (!Array.isArray(page.rows) || page.rows.length !== 1) throw new Error(`source row missing for ${candidate.instance_id}`);
  const task = visibleTask(page.rows[0], candidate.split);
  if (task.instance_id !== candidate.instance_id || task.source_row_digest !== candidate.source_row_digest) throw new Error(`source row drifted for ${candidate.instance_id}`);
  return task;
}

async function hydrate() {
  const pool = validatePool(readJson(POOL_FILE));
  const request = readJson(REQUEST_FILE);
  const selection = validateSelectionRecord(readJson(SELECTION_FILE), request, pool);
  const byId = new Map(pool.candidates.map((candidate) => [candidate.instance_id, candidate]));
  const assignment = readJson(ASSIGNMENT_FILE);
  verifyAttestation(assignment, request.attestation_public_key);
  const assignedIds = [...assignment.assignments.calibration, ...assignment.assignments.evaluation];
  const tasks = [];
  for (const instanceId of assignedIds) {
    tasks.push(await fetchRow(byId.get(instanceId)));
    process.stdout.write(`[${tasks.length}/${assignedIds.length}] ${instanceId}\n`);
  }
  const artifact = buildVisibleArtifact(selection, assignment, tasks, privateKey());
  writeJson(VISIBLE_FILE, artifact);
  return artifact;
}

function findNamedFiles(directory, filename) {
  if (!fs.existsSync(directory)) throw new Error(`evidence directory missing: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return findNamedFiles(absolute, filename);
    return entry.isFile() && entry.name === filename ? [absolute] : [];
  });
}

function ingestPreflight(directory) {
  const request = readJson(REQUEST_FILE); const selection = readJson(SELECTION_FILE);
  const summaries = findNamedFiles(path.resolve(directory), 'summary.json').map(readJson);
  const preflight = buildPreflight(selection, summaries, privateKey()); writeJson(PREFLIGHT_FILE, preflight);
  const assignment = buildAssignment(selection, preflight, privateKey()); writeJson(ASSIGNMENT_FILE, assignment);
  verifyAttestation(preflight, request.attestation_public_key); verifyAttestation(assignment, request.attestation_public_key);
  return { preflight_id: preflight.preflight_id, summaries: summaries.length, assignment_id: assignment.assignment_id, status: assignment.status, calibration: assignment.assignments.calibration.length, evaluation: assignment.assignments.evaluation.length };
}

function tasksForPhase(phase) {
  if (!PHASES.includes(phase)) throw new Error(`unsupported phase: ${phase}`);
  const assignment = readJson(ASSIGNMENT_FILE); const visible = readJson(VISIBLE_FILE); const ids = new Set(assignment.assignments[phase]);
  return visible.tasks.filter((task) => ids.has(task.instance_id));
}

function readAttempts(phase, planId) {
  return tasksForPhase(phase).map((task) => {
    const file = attemptFile(phase, planId, task.instance_id);
    if (!fs.existsSync(file)) throw new Error(`attempt missing: ${file}`);
    return readJson(file);
  });
}

async function generate(phase, planId) {
  if (!PHASES.includes(phase) || !PLANS.includes(planId)) throw new Error('generate requires a valid phase and plan');
  const health = await doctor(); if (health.status !== 'passed') throw new Error(`holdout environment doctor failed: ${JSON.stringify(health)}`);
  const request = readJson(REQUEST_FILE); const tasks = tasksForPhase(phase); const key = privateKey(); let completed = 0;
  for (const task of tasks) {
    const file = attemptFile(phase, planId, task.instance_id);
    if (fs.existsSync(file)) verifyAttestation(readJson(file), request.attestation_public_key);
    else {
      const frozenContext = fs.existsSync(contextFile(task.instance_id)) ? readJson(contextFile(task.instance_id)) : null;
      const attempt = signAttempt(await generateAttempt({ task, planId, retrievalArtifact: frozenContext }), request, key); writeJson(file, attempt);
      if (!frozenContext) writeJson(contextFile(task.instance_id), attempt.retrieval);
    }
    completed += 1; process.stdout.write(`[${completed}/${tasks.length}] ${phase}/${planId}/${task.instance_id}\n`);
  }
  return { status: 'complete', phase, plan_id: planId, attempts: completed };
}

function buildPredictions(phase, planId) {
  const attempts = readAttempts(phase, planId); const predictions = Object.fromEntries(attempts.map((attempt) => [attempt.instance_id, { model_patch: attempt.generated_patch }]));
  const file = predictionFile(phase, planId); writeJson(file, predictions); const evidence = buildPredictionEvidence({ phase, planId, attempts, predictionDigest: digest(predictions), privateKey: privateKey() }); writeJson(predictionEvidenceFile(phase, planId), evidence);
  return { prediction_file: path.relative(ROOT, file).replace(/\\/g, '/'), evidence_id: evidence.evidence_id, predictions: attempts.length };
}

function ingestVerdicts(phase, planId, directory) {
  const attempts = readAttempts(phase, planId); const summaries = findNamedFiles(path.resolve(directory), 'summary.json').map(readJson); const bundle = buildVerdictBundle({ phase, planId, attempts, summaries, privateKey: privateKey() }); writeJson(verdictFile(phase, planId), bundle); return { bundle_id: bundle.bundle_id, verdicts: bundle.verdicts.length, passed: bundle.verdicts.filter((verdict) => verdict.verification_status === 'passed').length, failed: bundle.verdicts.filter((verdict) => verdict.verification_status === 'failed').length, unknown: bundle.verdicts.filter((verdict) => verdict.verification_status === 'unknown').length };
}

function buildRoutes() {
  const assignment = readJson(ASSIGNMENT_FILE); const visible = readJson(VISIBLE_FILE); const calibrationAttemptSets = PLANS.map((planId) => readAttempts('calibration', planId)); const calibrationVerdictBundles = PLANS.map((planId) => readJson(verdictFile('calibration', planId))); const ledger = buildRouteLedger({ assignment, visibleTasks: visible.tasks, calibrationAttemptSets, calibrationVerdictBundles, privateKey: privateKey() }); writeJson(ROUTE_LEDGER_FILE, ledger); return { ledger_id: ledger.ledger_id, routes: ledger.routes.length, calibration_records: ledger.calibration_records };
}

function analyze() {
  const assignment = readJson(ASSIGNMENT_FILE); const visible = readJson(VISIBLE_FILE); const routeLedger = readJson(ROUTE_LEDGER_FILE); const evaluationAttemptSets = PLANS.map((planId) => readAttempts('evaluation', planId)); const evaluationVerdictBundles = PLANS.map((planId) => readJson(verdictFile('evaluation', planId))); const analysis = buildAnalysis({ assignment, visibleTasks: visible.tasks, routeLedger, evaluationAttemptSets, evaluationVerdictBundles, privateKey: privateKey() }); writeJson(ANALYSIS_FILE, analysis); return { analysis_id: analysis.analysis_id, primary: analysis.primary, static_comparison: analysis.static_comparison };
}

function verify() {
  const pool = validatePool(readJson(POOL_FILE));
  const request = readJson(REQUEST_FILE);
  if (request.pool_id !== pool.pool_id || request.request_id !== digest({ ...request, request_id: null })) throw new Error('selection request drifted');
  if (JSON.stringify(request.source_digests) !== JSON.stringify(sourceDigests())) throw new Error('frozen capstone sources drifted');
  const output = { status: 'pool-and-request-passed', pool_id: pool.pool_id, request_id: request.request_id };
  if (fs.existsSync(SELECTION_FILE)) {
    const selection = validateSelectionRecord(readJson(SELECTION_FILE), request, pool);
    output.status = 'selection-passed';
    output.selection_id = selection.selection_id;
  }
  for (const file of [PREFLIGHT_FILE, ASSIGNMENT_FILE, VISIBLE_FILE, ROUTE_LEDGER_FILE, ANALYSIS_FILE]) if (fs.existsSync(file)) verifyAttestation(readJson(file), request.attestation_public_key);
  return output;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'key') result = createKey();
  else if (command === 'doctor') result = await doctor();
  else if (command === 'pool') result = await buildCandidatePool();
  else if (command === 'request') result = buildRequest(args[0], args[1]);
  else if (command === 'select') result = await select();
  else if (command === 'hydrate') result = await hydrate();
  else if (command === 'ingest-preflight') result = ingestPreflight(args[0]);
  else if (command === 'generate') result = await generate(args[0], args[1]);
  else if (command === 'predictions') result = buildPredictions(args[0], args[1]);
  else if (command === 'ingest-verdicts') result = ingestVerdicts(args[0], args[1], args[2]);
  else if (command === 'routes') result = buildRoutes();
  else if (command === 'analyze') result = analyze();
  else if (command === 'verify') result = verify();
  else throw new Error('usage: public-holdout-capstone.js <key|doctor|pool|request ROUND ROUND_TIME|select|ingest-preflight DIR|hydrate|generate PHASE PLAN|predictions PHASE PLAN|ingest-verdicts PHASE PLAN DIR|routes|analyze|verify>');
  process.stdout.write(`${JSON.stringify(result.counts || result, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = Object.freeze({ ANALYSIS_FILE, ASSIGNMENT_FILE, BENCHMARK, KEY_FILE, POOL_FILE, PREFLIGHT_FILE, REQUEST_FILE, ROUTE_LEDGER_FILE, SELECTION_FILE, SOURCE_FILES, VISIBLE_FILE, buildCandidatePool, buildPredictions, buildRequest, buildRoutes, generate, hydrate, ingestPreflight, ingestVerdicts, sourceDigests, verify });
