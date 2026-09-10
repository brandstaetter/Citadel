#!/usr/bin/env node

'use strict';

// Carries hook findings across a turn boundary.
//
// opencode dispatches bus events fire-and-forget (`void hook["event"]?.(…)`), so
// `session.idle` cannot block the way a Claude Code Stop hook can: by the time
// quality-gate has an opinion, the turn is over and nothing can be refused. What
// *can* be done is deliver the finding on the next turn, by persisting it here and
// pushing it onto `chat.message`'s parts.
//
// One turn late is a real reduction and the runtime contract still says
// `stop-cannot-block`. But the finding reaching the model late beats it being
// discarded, which is what happened before.
//
// Notices are scoped to the session that produced them. The store is per project
// and opencode runs many sessions per project, so an unscoped store lets one
// session drain another's findings.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_VERSION = 1;
const STORE_DIR = path.join('.planning', 'opencode');
const STORE_FILE = 'pending-notices.json';

// `session.idle` fires many times per session (ten in the phase-5 run), and the
// gate's verdict is usually identical each time, so notices are deduped by content
// and capped. Without the cap a long session could accumulate an unbounded prompt
// injection; without the dedupe the model would see ten copies of one finding.
const MAX_NOTICES = 20;
const MAX_TEXT_LENGTH = 4000;

function storePath(projectRoot) {
  return path.join(projectRoot, STORE_DIR, STORE_FILE);
}

function noticeId(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function readStore(projectRoot) {
  const file = storePath(projectRoot);
  if (!fs.existsSync(file)) return { version: STORE_VERSION, notices: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.notices)) return { version: STORE_VERSION, notices: [] };
    return { version: STORE_VERSION, notices: parsed.notices.filter((item) => item && typeof item.text === 'string') };
  } catch {
    // A corrupt store must never break a turn. Start over rather than throwing:
    // losing a deferred notice is bad, breaking the session is worse.
    return { version: STORE_VERSION, notices: [] };
  }
}

function writeStore(projectRoot, store) {
  const file = storePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function sessionOf(value) {
  return typeof value === 'string' && value ? value : null;
}

// The store is per project, but opencode runs many sessions inside one project.
// A notice therefore belongs to the session whose turn produced it, and only that
// session may collect it -- otherwise a prompt in session B consumes session A's
// finding, and A is never told.
function sameSession(notice, sessionID) {
  return sessionOf(notice && notice.sessionID) === sessionOf(sessionID);
}

// Notices written before findings were scoped carry no sessionID. Rather than
// strand them, treat them as addressed to whoever asks next: the store is
// transient, so this only matters across a single upgrade.
function deliverableTo(notice, sessionID) {
  const owner = sessionOf(notice && notice.sessionID);
  return owner === null || owner === sessionOf(sessionID);
}

/**
 * Persist findings so the next turn can deliver them. Returns the notices added,
 * which is empty when everything was a duplicate.
 *
 * `options.sessionID` is the session whose idle produced the finding. Dedupe and
 * the cap both apply within that session: two sessions hitting the same finding
 * should each hear about it, and one noisy session must not evict another's.
 */
function record(projectRoot, event, messages, options = {}) {
  const texts = (Array.isArray(messages) ? messages : [messages])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, MAX_TEXT_LENGTH));
  if (texts.length === 0) return [];

  const sessionID = sessionOf(options.sessionID);
  const store = readStore(projectRoot);
  const seen = new Set(
    store.notices.filter((item) => sameSession(item, sessionID)).map((item) => item.id),
  );
  const added = [];

  for (const text of texts) {
    const id = noticeId(text);
    if (seen.has(id)) continue;
    seen.add(id);
    const notice = { id, event, sessionID, text, at: options.now || new Date().toISOString() };
    store.notices.push(notice);
    added.push(notice);
  }
  if (added.length === 0) return [];

  // Keep the newest when capped: a stale finding from early in the session is
  // less useful than the current one. Ids are content hashes and deduped within
  // the session, so they identify a notice uniquely here.
  const mine = store.notices.filter((item) => sameSession(item, sessionID));
  if (mine.length > MAX_NOTICES) {
    const keep = new Set(mine.slice(-MAX_NOTICES).map((item) => item.id));
    store.notices = store.notices.filter(
      (item) => !sameSession(item, sessionID) || keep.has(item.id),
    );
  }
  writeStore(projectRoot, store);
  return added;
}

/** Read the notices addressed to this session without consuming them. */
function peek(projectRoot, sessionID) {
  return readStore(projectRoot).notices.filter((item) => deliverableTo(item, sessionID));
}

/**
 * Return this session's pending notices and clear only those, so each finding is
 * delivered once and to the session it belongs to. Clearing first would risk
 * losing them if rendering threw, so the file is only rewritten after the caller
 * has the contents in hand.
 */
function drain(projectRoot, sessionID) {
  const all = readStore(projectRoot).notices;
  const mine = all.filter((item) => deliverableTo(item, sessionID));
  if (mine.length === 0) return [];
  try {
    writeStore(projectRoot, {
      version: STORE_VERSION,
      notices: all.filter((item) => !deliverableTo(item, sessionID)),
    });
  } catch {
    // If the store cannot be cleared, still deliver: a duplicate notice next turn
    // is better than a dropped one.
  }
  return mine;
}

/** Render notices as the text injected into the next turn. */
function renderForPrompt(notices) {
  if (!notices || notices.length === 0) return '';
  const lines = [
    '[Citadel] Findings from the end of the previous turn. opencode cannot block on',
    'the stop event, so these arrive now rather than before you finished. Address them',
    'before continuing, or say why they do not apply.',
    '',
  ];
  for (const notice of notices) lines.push(notice.text, '');
  return lines.join('\n').trimEnd();
}

module.exports = Object.freeze({
  MAX_NOTICES,
  MAX_TEXT_LENGTH,
  STORE_DIR,
  STORE_FILE,
  drain,
  noticeId,
  peek,
  record,
  renderForPrompt,
  storePath,
});
