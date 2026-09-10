'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { digest } = require('../operation-control/contracts');
const { extractJsonObjects } = require('../operation-control/receipt');
const { RETRIEVAL, retrieve } = require('./retrieval');
const { PLAN_IDS } = require('./router');

const MODELS = Object.freeze({
  [PLAN_IDS.local3]: Object.freeze({ runtime: 'ollama-chat', requested_model: 'qwen2.5-coder:3b', canonical_model: 'qwen2.5-coder:3b', model_digest: 'sha256:f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225' }),
  [PLAN_IDS.local7]: Object.freeze({ runtime: 'ollama-chat', requested_model: 'qwen2.5-coder:7b', canonical_model: 'qwen2.5-coder:7b', model_digest: 'sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364' }),
  [PLAN_IDS.cloud]: Object.freeze({ runtime: 'claude-code-print', requested_model: 'sonnet', canonical_model: 'claude-sonnet-5', cli_version: '2.1.219' }),
});

const ECONOMICS = Object.freeze({
  electricity_usd_per_kwh: 0.20,
  gpu_residual_value_usd: 100,
  gpu_useful_compute_hours: 10000,
  actual_subscription_cash_status: 'unknown',
  whole_system_energy_status: 'unknown',
});

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const { CLAUDE_BIN, spawnClaudeSync } = require('../forks/claude-launcher');

function run(executable, args, options = {}) {
  const result = childProcess.spawnSync(executable, args, { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}

function materializeRepository(task, cacheRoot, workspace) {
  const cache = path.join(cacheRoot, digest(task.repo).slice(7, 31));
  fs.mkdirSync(cacheRoot, { recursive: true });
  if (!fs.existsSync(cache)) run('git', ['-c', 'core.hooksPath=NUL', 'clone', '--bare', '--filter=blob:none', `https://github.com/${task.repo}.git`, cache], { timeout: 600000 });
  run('git', ['-c', 'core.hooksPath=NUL', 'fetch', '--force', 'origin', task.base_commit], { cwd: cache, timeout: 600000 });
  if (fs.existsSync(workspace)) throw new Error(`workspace already exists: ${workspace}`);
  run('git', ['-c', 'core.hooksPath=NUL', 'worktree', 'add', '--detach', workspace, task.base_commit], { cwd: cache, timeout: 600000 });
  return Object.freeze({ cache, workspace, commit: run('git', ['rev-parse', 'HEAD'], { cwd: workspace }).trim() });
}

function removeWorkspace(materialized) {
  if (!materialized || !materialized.cache || !materialized.workspace) return;
  run('git', ['worktree', 'remove', '--force', materialized.workspace], { cwd: materialized.cache, timeout: 120000 });
}

function promptFor(task, retrieval) {
  const files = retrieval.files.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n');
  return `Fix the repository issue below at the pinned base commit.\n\nISSUE\n${task.problem_statement}\n\nRETRIEVED REPOSITORY FILES\n${files}\n\nReturn only JSON with the exact shape {"files":{"relative/path":"complete replacement content"}}. You may replace only paths shown above. Include only files that must change. Preserve unrelated behavior. Do not use Markdown fences or commentary.`;
}

function parseFiles(output, retrieval) {
  const allowed = new Set(retrieval.files.map((file) => file.path));
  const objects = extractJsonObjects(output).filter((value) => value && value.files && typeof value.files === 'object' && !Array.isArray(value.files));
  if (!objects.length) return { status: 'failed', code: 'FILES_JSON_INVALID', files: null };
  const files = {};
  for (const [rawPath, content] of Object.entries(objects[objects.length - 1].files)) {
    const relative = rawPath.replace(/\\/g, '/');
    if (!allowed.has(relative) || typeof content !== 'string') return { status: 'failed', code: 'OUTPUT_PATH_NOT_RETRIEVED', files: null };
    files[relative] = content;
  }
  if (!Object.keys(files).length) return { status: 'failed', code: 'EMPTY_CHANGE_SET', files: null };
  return { status: 'passed', code: null, files };
}

function applyFiles(workspace, parsed) {
  if (parsed.status !== 'passed') return { patch: '', patch_digest: digest(''), changed_paths: [] };
  for (const [relative, content] of Object.entries(parsed.files)) {
    const target = path.resolve(workspace, relative);
    if (!target.startsWith(`${path.resolve(workspace)}${path.sep}`)) throw new Error(`output path escaped workspace: ${relative}`);
    fs.writeFileSync(target, content, 'utf8');
  }
  const patch = run('git', ['--no-pager', 'diff', 'HEAD', '--text', '--no-ext-diff'], { cwd: workspace });
  const changedPaths = run('git', ['diff', '--name-only', 'HEAD'], { cwd: workspace }).split(/\r?\n/).filter(Boolean).sort();
  return Object.freeze({ patch, patch_digest: digest(patch.replace(/\r\n/g, '\n')), changed_paths: changedPaths });
}

function requestJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url); const encoded = Buffer.from(JSON.stringify(body));
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': encoded.length } }, (response) => { const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => { if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`)); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } }); });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('model request timed out'))); request.on('error', reject); request.end(encoded);
  });
}

function startGpuSampler() {
  const samples = []; const child = childProcess.spawn('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits', '-lms', '500'], { shell: false, windowsHide: true }); let pending = '';
  child.stdout.on('data', (chunk) => { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) { const watts = Number(line.trim()); if (Number.isFinite(watts)) samples.push(watts); } });
  return async (durationMs) => { if (!child.killed) child.kill(); await new Promise((resolve) => setTimeout(resolve, 100)); if (!samples.length) return { status: 'unknown', samples: 0, average_watts: null, energy_kwh: null }; const average = samples.reduce((sum, value) => sum + value, 0) / samples.length; return { status: 'measured', samples: samples.length, average_watts: Number(average.toFixed(6)), energy_kwh: Number((average * durationMs / 3_600_000_000).toFixed(9)) }; };
}

function localEconomics(gpu, durationMs) {
  if (gpu.status !== 'measured') return { comparison_cost: { status: 'unknown', amount_usd: null, source: 'gpu-energy-missing' }, actual_subscription_cash: { status: 'not-applicable', amount_usd: 0 }, gpu };
  const electricity = gpu.energy_kwh * ECONOMICS.electricity_usd_per_kwh;
  const amortization = (durationMs / 3600000) * (ECONOMICS.gpu_residual_value_usd / ECONOMICS.gpu_useful_compute_hours);
  return { comparison_cost: { status: 'derived-comparison', amount_usd: Number((electricity + amortization).toFixed(9)), source: 'measured-gpu-energy-plus-frozen-residual-amortization' }, actual_subscription_cash: { status: 'not-applicable', amount_usd: 0 }, gpu };
}

async function generateLocal(planId, prompt) {
  const model = MODELS[planId]; const stopSampler = startGpuSampler(); const startedAt = new Date().toISOString(); const started = Date.now(); let response; let error = null;
  try { response = await requestJson(`${OLLAMA_ENDPOINT}/api/chat`, { model: model.requested_model, stream: false, keep_alive: 0, format: 'json', messages: [{ role: 'user', content: prompt }], options: { temperature: 0, num_predict: 4096, num_ctx: 16384, seed: 83 } }, 600000); } catch (caught) { error = caught.message; }
  const durationMs = Date.now() - started; const gpu = await stopSampler(durationMs); const output = String(response?.message?.content || ''); const verified = response?.done === true && response?.model === model.requested_model;
  return { started_at: startedAt, duration_ms: durationMs, output, usage: { input_tokens: Number(response?.prompt_eval_count || 0), output_tokens: Number(response?.eval_count || 0) }, execution_evidence: { status: verified ? 'verified' : 'unknown', runtime: model.runtime, requested_model: model.requested_model, canonical_model: response?.model || null, model_digest: model.model_digest, response_digest: response ? digest(response) : null, error }, economics: localEconomics(gpu, durationMs) };
}

async function doctor() {
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`); if (!response.ok) throw new Error(`Ollama doctor HTTP ${response.status}`); const tags = await response.json(); const installed = new Map((tags.models || []).map((model) => [model.name, model]));
  const local = [PLAN_IDS.local3, PLAN_IDS.local7].map((planId) => { const expected = MODELS[planId]; const observed = installed.get(expected.requested_model); return { plan_id: planId, requested_model: expected.requested_model, expected_digest: expected.model_digest, observed_digest: observed ? `sha256:${observed.digest}` : null, status: observed && `sha256:${observed.digest}` === expected.model_digest ? 'passed' : 'failed' }; });
  const claude = spawnClaudeSync(['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 }); const gpu = childProcess.spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 });
  const cloud = { plan_id: PLAN_IDS.cloud, expected_cli_version: MODELS[PLAN_IDS.cloud].cli_version, observed_cli_version: claude.status === 0 ? String(claude.stdout).trim() : null, status: claude.status === 0 && String(claude.stdout).startsWith(MODELS[PLAN_IDS.cloud].cli_version) ? 'passed' : 'failed' };
  return Object.freeze({ schema: 1, kind: 'citadel_public_holdout_environment_doctor', status: local.every((entry) => entry.status === 'passed') && cloud.status === 'passed' && gpu.status === 0 ? 'passed' : 'failed', models: [...local, cloud], gpu: gpu.status === 0 ? String(gpu.stdout).trim() : null, platform: process.platform, arch: process.arch, cpu_count: os.cpus().length, total_memory_bytes: os.totalmem(), node: process.version });
}

async function generateClaude(prompt) {
  const model = MODELS[PLAN_IDS.cloud]; const startedAt = new Date().toISOString(); const started = Date.now(); const result = spawnClaudeSync(['-p', '--input-format', 'text', '--output-format', 'json', '--model', model.requested_model, '--tools', '', '--permission-mode', 'dontAsk', '--no-session-persistence', '--safe-mode', '--system-prompt', 'Return only the requested JSON. Do not use tools, network access, or hidden information.', '--disable-slash-commands'], { input: prompt, encoding: 'utf8', shell: false, windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }); const durationMs = Date.now() - started;
  let envelope = null; let parseError = null; try { envelope = JSON.parse(result.stdout || ''); } catch (error) { parseError = error.message; }
  const observed = Object.values(envelope?.modelUsage || {}).some((entry) => entry.canonicalModel === model.canonical_model); const amount = Number(envelope?.total_cost_usd); const usage = envelope?.usage || {};
  return { started_at: startedAt, duration_ms: durationMs, output: typeof envelope?.result === 'string' ? envelope.result : '', usage: { input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0), cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0) }, execution_evidence: { status: result.status === 0 && envelope?.subtype === 'success' && observed ? 'verified' : 'unknown', runtime: model.runtime, requested_model: model.requested_model, canonical_model: observed ? model.canonical_model : null, cli_version: model.cli_version, response_digest: envelope ? digest(envelope) : null, exit_status: result.status, error: result.error?.message || parseError }, economics: { comparison_cost: Number.isFinite(amount) ? { status: 'provider-reported-equivalent', amount_usd: Number(amount.toFixed(9)), source: 'claude-code-total-cost-usd' } : { status: 'unknown', amount_usd: null, source: 'provider-cost-missing' }, actual_subscription_cash: { status: 'unknown', amount_usd: null, source: 'subscription-not-allocated-per-operation' }, gpu: { status: 'not-applicable', samples: 0, average_watts: null, energy_kwh: 0 } } };
}

function validateRetrieval(workspace, task, retrievalArtifact) {
  if (!retrievalArtifact || retrievalArtifact.instance_id !== task.instance_id || retrievalArtifact.retrieval_id !== digest({ ...retrievalArtifact, retrieval_id: null })) throw new Error(`frozen retrieval identity invalid: ${task.instance_id}`);
  for (const file of retrievalArtifact.files) {
    const target = path.resolve(workspace, file.path); const root = path.resolve(workspace);
    if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) throw new Error(`frozen retrieval path invalid: ${file.path}`);
    const content = fs.readFileSync(target, 'utf8').slice(0, RETRIEVAL.maximum_file_characters);
    if (digest(content) !== file.content_digest || content !== file.content) throw new Error(`frozen retrieval content drifted: ${file.path}`);
  }
  return retrievalArtifact;
}

async function generateAttempt({ task, planId, cacheRoot = path.join(os.tmpdir(), 'citadel-public-holdout-cache'), retrievalArtifact = null }) {
  if (!MODELS[planId]) throw new Error(`unsupported plan: ${planId}`);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `citadel-holdout-${planId}-`)); fs.rmSync(workspace, { recursive: true, force: true });
  let materialized;
  try {
    materialized = materializeRepository(task, cacheRoot, workspace);
    if (materialized.commit !== task.base_commit) throw new Error(`base commit mismatch for ${task.instance_id}`);
    const retrieval = retrievalArtifact ? validateRetrieval(workspace, task, retrievalArtifact) : retrieve(workspace, task); const prompt = promptFor(task, retrieval); const generated = planId === PLAN_IDS.cloud ? await generateClaude(prompt) : await generateLocal(planId, prompt); const parsed = parseFiles(generated.output, retrieval); const patch = applyFiles(workspace, parsed);
    const unsigned = { schema: 1, kind: 'citadel_public_holdout_model_attempt', attempt_id: null, instance_id: task.instance_id, plan_id: planId, base_commit: task.base_commit, retrieval, prompt_digest: digest(prompt), output_text: generated.output, output_digest: digest(generated.output), parse_status: parsed.status, parse_failure_code: parsed.code, generated_patch: patch.patch, generated_patch_digest: patch.patch_digest, changed_paths: patch.changed_paths, started_at: generated.started_at, duration_ms: generated.duration_ms, usage: generated.usage, execution_evidence: generated.execution_evidence, economics: generated.economics, hidden_verification: { status: 'not-run', source: 'official-swe-bench-live-evaluator' } };
    return Object.freeze({ ...unsigned, attempt_id: digest(unsigned) });
  } finally { if (materialized) removeWorkspace(materialized); else if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true }); }
}

module.exports = Object.freeze({ CLAUDE_BIN, ECONOMICS, MODELS, OLLAMA_ENDPOINT, applyFiles, doctor, generateAttempt, materializeRepository, parseFiles, promptFor, removeWorkspace, validateRetrieval });
