'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { generateShorthands, renderSkill } = require('../core/skills/codex-shorthands');
const packageManifest = require('../package.json');
assert(packageManifest.files.includes('scripts/codex-shorthands.js'));
assert(packageManifest.files.includes('core/skills/'));
assert.match(fs.readFileSync(path.join(__dirname, '../skills/setup/SKILL.md'), 'utf8'), /scripts\/codex-shorthands\.js --project-root/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-shorthands-'));
const source = path.join(temp, 'source');
const project = path.join(temp, 'project');
fs.mkdirSync(project);
for (const name of ['do', 'review', 'test-gen']) {
  fs.mkdirSync(path.join(source, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}
const run = (options = {}) => generateShorthands({ projectRoot: project, citadelRoot: source, ...options });
assert.deepEqual(run({ dryRun: true }).created, ['do', 'review', 'test-gen']);
assert(!fs.existsSync(path.join(project, '.agents')));
assert.deepEqual(run().created, ['do', 'review', 'test-gen']);
assert.deepEqual(run().unchanged, ['do', 'review', 'test-gen']);
const skill = path.join(project, '.agents', 'skills', 'do', 'SKILL.md');
assert.equal(fs.readFileSync(skill, 'utf8'), renderSkill('do'));
assert.match(renderSkill('review'), /exact `citadel:review`/);
assert.match(fs.readFileSync(path.join(project, '.agents/skills/do/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
// Simulate an older, receipt-owned wrapper to exercise safe refresh.
const receipt = path.join(project, '.citadel/codex-shorthand-ownership.json');
fs.writeFileSync(skill, 'previous generated version');
const hash = crypto.createHash('sha256');
hash.update(JSON.stringify('SKILL.md')).update('file').update('previous generated version');
hash.update(JSON.stringify('agents')).update('directory');
hash.update(JSON.stringify(path.join('agents', 'openai.yaml'))).update('file')
  .update(fs.readFileSync(path.join(project, '.agents/skills/do/agents/openai.yaml')));
const ownership = JSON.parse(fs.readFileSync(receipt, 'utf8'));
ownership.skills.do = hash.digest('hex');
fs.writeFileSync(receipt, JSON.stringify(ownership));
assert.deepEqual(run({ dryRun: true }).updated, ['do']);
assert.equal(fs.readFileSync(skill, 'utf8'), 'previous generated version');
assert.deepEqual(run().updated, ['do']);
assert.equal(fs.readFileSync(skill, 'utf8'), renderSkill('do'));
fs.appendFileSync(skill, '\nUser customization\n');
assert.deepEqual(run().preserved, ['do']);
assert.match(fs.readFileSync(skill, 'utf8'), /User customization/);
const unowned = path.join(project, '.agents/skills/custom');
fs.mkdirSync(unowned);
fs.writeFileSync(path.join(unowned, 'SKILL.md'), 'user skill');
fs.mkdirSync(path.join(source, 'skills/custom'));
fs.writeFileSync(path.join(source, 'skills/custom/SKILL.md'), 'new skill');
assert.deepEqual(run().preserved, ['custom', 'do']);
assert.equal(fs.readFileSync(path.join(unowned, 'SKILL.md'), 'utf8'), 'user skill');
fs.renameSync(path.join(source, 'skills/review'), path.join(source, 'retired-review'));
assert.deepEqual(run().stale, ['review']);
assert(fs.existsSync(path.join(project, '.agents/skills/review/SKILL.md')));
fs.writeFileSync(receipt, '{broken');
assert.throws(run);
assert.match(fs.readFileSync(skill, 'utf8'), /User customization/);

// Parent redirection must be rejected before any wrappers or receipt are written.
const redirected = path.join(temp, 'redirected');
const outside = path.join(temp, 'outside');
fs.mkdirSync(redirected);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(redirected, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
assert.throws(() => run({ projectRoot: redirected }), /linked path/);
assert.deepEqual(fs.readdirSync(outside), []);
assert(!fs.existsSync(path.join(redirected, '.citadel')));

console.log('Codex shorthand tests passed: discovery, dry-run, idempotence, refresh, delegation, collisions, edits, retirement, invalid receipt, linked parent.');
