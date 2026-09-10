#!/usr/bin/env node

/**
 * local-daemon.js -- Quota-free replacement for /daemon start.
 *
 * Cross-platform Node port of scripts/daemon-tick.ps1. Spawns a fresh
 * `claude -p "/do continue"` subprocess, waits for it to finish, applies a
 * cooldown, and repeats until daemon.json reports the daemon is no longer
 * running (campaign completed, budget exhausted, level-up pending, etc).
 *
 * The SessionStart hook (init-project.js) reads .planning/daemon.json on
 * every session start. Explicit localRunnerEnabled state authorizes
 * continuation; the environment variable alone does not. It does NOT use
 * RemoteTrigger, so it consumes zero Anthropic routine quota.
 *
 * Usage:
 *   node scripts/local-daemon.js                   # Default 60s cooldown, 10 sessions
 *   node scripts/local-daemon.js --cooldown 30     # 30s between sessions
 *   node scripts/local-daemon.js --max-sessions 10 # Safety cap
 *   node scripts/local-daemon.js --dry-run         # Print what it would do
 *
 * Start with `/daemon start` first (or manually populate daemon.json) to
 * establish the campaign and budget. This runner only drives the tick loop.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { platformInvocation } = require('../core/forks/launcher');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DAEMON_PATH = path.join(ROOT, '.planning', 'daemon.json');
const LOG_PATH = path.join(ROOT, '.planning', 'daemon-runs.log');

const args = process.argv.slice(2);
const opts = {
    cooldown: Number(getFlag('--cooldown', '60')) * 1000,
    maxSessions: Number(getFlag('--max-sessions', '10')),
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
};

function getFlag(name, fallback) {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    return args[i + 1] ?? fallback;
}

if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n').replace(/^ \*\/?/gm, ''));
    process.exit(0);
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* ignore */ }
}

function readDaemon() {
    if (!fs.existsSync(DAEMON_PATH)) return null;
    try { return JSON.parse(fs.readFileSync(DAEMON_PATH, 'utf8')); }
    catch (e) { log(`daemon.json parse error: ${e.message}`); return null; }
}

function runSession() {
    return new Promise((resolve) => {
        const cmd = 'claude';
        const cliArgs = ['--permission-mode', 'default', '-p', '/do continue'];
        if (opts.dryRun) {
            log(`DRY RUN would spawn: ${cmd} ${cliArgs.join(' ')}`);
            return resolve(0);
        }
        const invocation = platformInvocation({ command: cmd, args: cliArgs });
        const proc = spawn(invocation.command, invocation.args, {
            cwd: ROOT,
            stdio: 'inherit',
            env: { ...process.env, CLAUDE_NON_INTERACTIVE: '1' },
            shell: false,
        });
        proc.on('close', (code) => resolve(code ?? 1));
        proc.on('error', (err) => { log(`spawn error: ${err.message}`); resolve(1); });
    });
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
    log(`local-daemon starting. root=${ROOT} cooldown=${opts.cooldown}ms`);
    if (!Number.isInteger(opts.maxSessions) || opts.maxSessions < 1 ||
        !Number.isFinite(opts.cooldown) || opts.cooldown < 0) {
        throw new Error('Use a positive integer --max-sessions and nonnegative --cooldown.');
    }
    let sessions = 0;
    while (true) {
        const state = readDaemon();
        if (!state) { log('No daemon.json found. Exiting.'); break; }
        if (state.status !== 'running') {
            log(`Daemon status is "${state.status}". Reason: ${state.stopReason ?? 'n/a'}. Exiting.`);
            break;
        }
        if (state.localRunnerEnabled !== true) { log('Local runner requires localRunnerEnabled: true in daemon.json.'); break; }
        if (typeof state.budget !== 'number' || !Number.isFinite(state.budget) || state.budget <= 0 ||
            typeof state.estimatedSpend !== 'number' || !Number.isFinite(state.estimatedSpend) ||
            state.estimatedSpend < 0 || state.estimatedSpend >= state.budget) {
            log('A finite, unexhausted budget and valid estimatedSpend are required.'); break;
        }
        const slug = state.campaignSlug;
        if (typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) { log('Invalid campaign slug.'); break; }
        const campaign = path.join(ROOT, '.planning', 'campaigns', slug + '.md');
        if (!fs.existsSync(campaign) || !/^status:\s*active\s*$/m.test(fs.readFileSync(campaign, 'utf8'))) {
            log('Campaign is not active.'); break;
        }
        if (state.lastTickStatus === 'running' && (!state.lastTickAt ||
            !Number.isFinite(Date.parse(state.lastTickAt)) || Date.now() - Date.parse(state.lastTickAt) < 120000)) {
            log('Another session may still be active.'); break;
        }
        if (sessions >= opts.maxSessions) {
            log(`Reached --max-sessions (${opts.maxSessions}). Exiting.`);
            break;
        }
        const cost = state.costPerSession ?? 3;
        const reserved = state.localEstimatedSpend ?? 0;
        if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 ||
            typeof reserved !== 'number' || !Number.isFinite(reserved) || reserved < 0 ||
            Math.max(state.estimatedSpend, reserved) + cost > state.budget) {
            log('The next estimated session would exceed the budget, or cost state is invalid.'); break;
        }
        if (!opts.dryRun) {
            // Keep a conservative reservation separate from agent-written accounting.
            // Failed sessions may still incur cost. Never refund automatically.
            state.localEstimatedSpend = Math.max(state.estimatedSpend, reserved) + cost;
            fs.writeFileSync(DAEMON_PATH, JSON.stringify(state, null, 2) + '\n');
        }
        sessions += 1;
        log(`Starting session #${sessions} (daemon session count: ${state.sessionCount ?? 0})`);
        const code = await runSession();
        log(`Session #${sessions} exited with code ${code}`);
        if (code !== 0) { process.exitCode = code; break; }
        if (sessions >= opts.maxSessions) break;
        log(`Cooldown ${opts.cooldown / 1000}s...`);
        await sleep(opts.cooldown);
    }
    log(`local-daemon stopped after ${sessions} session(s).`);
}

main().catch((err) => { log(`fatal: ${err.stack ?? err.message}`); process.exit(1); });

process.on('SIGINT', () => { log('received SIGINT, stopping after current session'); process.exit(0); });
