#!/usr/bin/env node

/**
 * local-schedule.js -- Quota-free replacement for /schedule add.
 *
 * Installs scheduled tasks using the host OS's native scheduler (Windows
 * Task Scheduler or Unix cron) rather than Anthropic's CronCreate. Does not
 * consume routine quota. Survives session end, machine sleep (wakes the
 * system if configured), and reboots.
 *
 * Each scheduled task runs:
 *   claude --permission-mode default -p "<command>" (through a project-owned job record)
 *
 * Usage:
 *   node scripts/local-schedule.js add "<cron-or-human>" "<claude-command>" --confirm
 *   node scripts/local-schedule.js add "every 30m" "/pr-watch" --confirm
 *   node scripts/local-schedule.js add "0 9 * * *" "/do continue" --confirm
 *   node scripts/local-schedule.js list
 *   node scripts/local-schedule.js remove <id>
 *
 * IDs are prefixed `citadel-` on both platforms so they're easy to find.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { platformInvocation } = require('../core/forks/launcher');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const IS_WIN = process.platform === 'win32';

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n').replace(/^ \*\/?/gm, ''));
    process.exit(cmd ? 0 : 1);
}

function toCron(expr) {
    const t = expr.trim().toLowerCase();
    const map = {
        'every minute': '* * * * *',
        'every 5m': '*/5 * * * *', 'every 5 minutes': '*/5 * * * *',
        'every 15m': '*/15 * * * *', 'every 15 minutes': '*/15 * * * *',
        'every 30m': '*/30 * * * *', 'every 30 minutes': '*/30 * * * *',
        'hourly': '0 * * * *', 'every hour': '0 * * * *',
        'every 2h': '0 */2 * * *', 'every 2 hours': '0 */2 * * *',
        'every 6h': '0 */6 * * *', 'every 6 hours': '0 */6 * * *',
        'daily': '0 9 * * *', 'every day': '0 9 * * *',
        'every weekday': '0 9 * * 1-5',
    };
    if (map[t]) return map[t];
    if (/^[0-9*,/\-]+(?: +[0-9*,/\-]+){4}$/.test(expr.trim())) return expr.trim();
    throw new Error(`Could not parse schedule "${expr}". Use a 5-field cron expression or a phrase like "every 30m".`);
}

function newId() {
    return `citadel-${crypto.randomBytes(4).toString('hex')}`;
}

function validateId(id) {
    if (!/^citadel-[a-f0-9]{8}$/.test(id)) throw new Error('Invalid Citadel schedule ID.');
    return id;
}

function recordPath(id, root = ROOT) {
    return path.join(root, '.citadel', 'schedules', validateId(id) + '.json');
}

function saveJob(id, command) {
    const file = recordPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id, command, projectRoot: path.resolve(ROOT) }) + '\n', { flag: 'wx', mode: 0o600 });
}

function forgetJob(id) {
    fs.rmSync(recordPath(id), { force: true });
}

function quoteTaskPath(value) {
    // cron handles % even inside shell quotes. Windows task command lines need
    // literal paths, never shell expansion. Reject unsupported paths explicitly.
    if (/[\r\n\0%"]/.test(value)) throw new Error('Unsupported scheduler path.');
    return IS_WIN ? '"' + value + '"' : "'" + value.replace(/'/g, "'\\''") + "'";
}

function jobInvocation(id) {
    const payload = Buffer.from(JSON.stringify({ id, root: path.resolve(ROOT) })).toString('base64url');
    return quoteTaskPath(process.execPath) + ' ' + quoteTaskPath(__filename) + ' run ' + payload;
}

function runJob(payload) {
    if (!/^[a-zA-Z0-9_-]+$/.test(payload || '')) throw new Error('Invalid job payload.');
    const { id, root } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Invalid project root.');
    const file = recordPath(id, root);
    // Removal deletes .citadel. Retained OS entries then become inert.
    if (!fs.existsSync(file)) return;
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (job.id !== id || job.projectRoot !== root || typeof job.command !== 'string' || !job.command.trim()) {
        throw new Error('Invalid schedule record.');
    }
    const invocation = platformInvocation({ command: 'claude', args: ['--permission-mode', 'default', '-p', '--', job.command] });
    const result = spawnSync(invocation.command, invocation.args, { cwd: root, shell: false, stdio: 'inherit', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
}

// --- Windows: schtasks -------------------------------------------------------

function winAdd(cronExpr, claudeCommand) {
    const parts = cronExpr.split(/\s+/);
    const [minute, hour] = parts;
    const id = newId();
    const invocation = jobInvocation(id);
    // Reject unsupported dates rather than silently broadening the cadence.
    if (parts.slice(2).join(' ') !== '* * *') throw new Error('Windows supports only daily or interval schedules.');
    let schtasksArgs;
    if (parts.join(' ') === '* * * * *') {
        schtasksArgs = ['/Create', '/SC', 'MINUTE', '/MO', '1', '/TN', id, '/TR', invocation, '/F'];
    } else if (/^\*\/\d+$/.test(minute) && hour === '*') {
        const mo = minute.slice(2);
        schtasksArgs = ['/Create', '/SC', 'MINUTE', '/MO', mo, '/TN', id, '/TR', invocation, '/F'];
    } else if (minute === '0' && /^\*\/\d+$/.test(hour)) {
        schtasksArgs = ['/Create', '/SC', 'HOURLY', '/MO', hour.slice(2), '/TN', id, '/TR', invocation, '/F'];
    } else if (minute === '0' && hour === '*') {
        schtasksArgs = ['/Create', '/SC', 'HOURLY', '/MO', '1', '/TN', id, '/TR', invocation, '/F'];
    } else if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && Number(hour) < 24 && Number(minute) < 60) {
        schtasksArgs = ['/Create', '/SC', 'DAILY', '/ST', `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, '/TN', id, '/TR', invocation, '/F'];
    } else {
        throw new Error(`Windows Task Scheduler mapping not supported for "${cronExpr}". Use: every {N}m, every {N}h, or daily at {H}.`);
    }
    saveJob(id, claudeCommand);
    try { execFileSync('schtasks', schtasksArgs, { stdio: 'inherit' }); }
    catch (error) { forgetJob(id); throw error; }
    console.log(`Scheduled. ID: ${id}`);
    console.log(`Remove with: node scripts/local-schedule.js remove ${id}`);
}

function winList() {
    const out = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const lines = (out.stdout || '').split('\n').filter((l) => l.includes('citadel-'));
    if (!lines.length) { console.log('No Citadel schedules found.'); return; }
    for (const line of lines) console.log(line.trim());
}

function winRemove(id) {
    execFileSync('schtasks', ['/Delete', '/TN', id, '/F'], { stdio: 'inherit' });
    forgetJob(id);
    console.log(`Removed ${id}`);
}

// --- Unix: crontab -----------------------------------------------------------

const CRON_MARKER_START = '# CITADEL-SCHEDULES-START';
const CRON_MARKER_END = '# CITADEL-SCHEDULES-END';

function readCrontab() {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout;
    if (!r.error && /no crontab for/i.test(r.stderr || '')) return '';
    throw new Error('Could not read crontab; refusing to replace it.');
}

function writeCrontab(content) {
    const r = spawnSync('crontab', ['-'], { input: content, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`crontab install failed: ${r.stderr}`);
}

function unixAdd(cronExpr, claudeCommand) {
    const id = newId();
    const current = readCrontab();
    const line = `${cronExpr} ${jobInvocation(id)} # ${id}`;
    let updated;
    if (current.includes(CRON_MARKER_START)) {
        updated = current.replace(CRON_MARKER_END, `${line}\n${CRON_MARKER_END}`);
    } else {
        updated = current + (current.endsWith('\n') || !current ? '' : '\n') +
            `${CRON_MARKER_START}\n${line}\n${CRON_MARKER_END}\n`;
    }
    saveJob(id, claudeCommand);
    try { writeCrontab(updated); } catch (error) { forgetJob(id); throw error; }
    console.log(`Scheduled. ID: ${id}`);
    console.log(`Remove with: node scripts/local-schedule.js remove ${id}`);
}

function unixList() {
    const current = readCrontab();
    const lines = current.split('\n').filter((l) => l.includes('# citadel-'));
    if (!lines.length) { console.log('No Citadel schedules found.'); return; }
    for (const line of lines) console.log(line);
}

function unixRemove(id) {
    const current = readCrontab();
    const updated = current.split('\n').filter((l) => !l.trimEnd().endsWith(`# ${id}`)).join('\n');
    writeCrontab(updated);
    forgetJob(id);
    console.log(`Removed ${id}`);
}

// --- Dispatch ----------------------------------------------------------------

try {
    if (cmd === 'run') {
        runJob(rest[0]);
    } else if (cmd === 'add') {
        if (rest.length !== 3 || rest[2] !== '--confirm') throw new Error('Review the cadence, command and persistence, then pass --confirm to create the OS schedule.');
        const [expr, claudeCommand] = rest;
        if (!expr || !claudeCommand) { console.error('Usage: add "<cron>" "<claude command>"'); process.exit(1); }
        const cron = toCron(expr);
        console.log(`Installing: ${cron} -> ${claudeCommand}`);
        IS_WIN ? winAdd(cron, claudeCommand) : unixAdd(cron, claudeCommand);
    } else if (cmd === 'list') {
        IS_WIN ? winList() : unixList();
    } else if (cmd === 'remove') {
        const id = rest[0];
        validateId(id);
        IS_WIN ? winRemove(id) : unixRemove(id);
    } else {
        console.error(`Unknown command: ${cmd}. Use add|list|remove.`);
        process.exit(1);
    }
} catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
}
