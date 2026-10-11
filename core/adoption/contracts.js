'use strict';

const crypto = require('crypto');
const path = require('path');
const { sha256Digest } = require('../operations/canonical');
const { validateMigration } = require('./migrations');

const CONTRACT_VERSION = '1.0';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLAN_STATUSES = Object.freeze(['ready', 'confirmation_required', 'blocked']);
const OPERATIONS = Object.freeze(['adopt', 'leave', 'update', 'rollback', 'restore', 'import']);
const OWNERSHIP = Object.freeze(['owned', 'shared', 'ambiguous', 'user_state']);
const ACTIONS = Object.freeze(['create', 'replace', 'remove']);
const PLAN_FIELDS = Object.freeze([
  'contract_version', 'kind', 'operation', 'plan_id', 'created_at', 'target',
  'source', 'runtime', 'status', 'blockers', 'warnings', 'confirmation',
  'effects', 'footprint_preview', 'verification', 'rollback', 'archive',
  'migration', 'generation', 'predecessor', 'runtime_projections', 'plan_digest',
]);
const FOOTPRINT_FIELDS = Object.freeze([
  'contract_version', 'kind', 'entries', 'manifest_digest',
]);
const FOOTPRINT_ENTRY_FIELDS = Object.freeze([
  'entry_id', 'path', 'kind', 'ownership', 'required', 'before',
  'installed_digest', 'installed_bytes', 'removal', 'preimage_base64',
]);
const EFFECT_FIELDS = Object.freeze([
  'effect_id', 'action', 'path', 'ownership', 'before', 'after', 'content_base64',
]);
const RECEIPT_FIELDS = Object.freeze([
  'contract_version', 'kind', 'receipt_id', 'operation_id', 'plan_id',
  'plan_digest', 'source', 'target', 'runtime', 'footprint',
  'observed_effects', 'verification', 'journal_head', 'state', 'issued_at',
  'migration', 'generation', 'predecessor', 'runtime_projections',
  'receipt_digest',
]);
const JOURNAL_FIELDS = Object.freeze([
  'contract_version', 'kind', 'sequence', 'operation_id', 'phase', 'effect_id',
  'state', 'payload_digest', 'evidence_digest', 'reason_code', 'recorded_at',
  'previous_digest', 'entry_digest',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, fields, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be a plain object`);
    return false;
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    errors.push(`${label} fields must exactly match the v1 contract`);
    return false;
  }
  return true;
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value)
    && !value.includes('\\') && path.posix.normalize(value) === value
    && value !== '..' && !value.startsWith('../');
}

function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function validateSnapshot(value, label, errors) {
  if (!exact(value, ['exists', 'digest', 'bytes'], label, errors)) return;
  if (typeof value.exists !== 'boolean') errors.push(`${label}.exists must be boolean`);
  if (value.digest !== null && !DIGEST.test(value.digest)) errors.push(`${label}.digest is invalid`);
  if (!Number.isInteger(value.bytes) || value.bytes < 0) errors.push(`${label}.bytes is invalid`);
  if (!value.exists && (value.digest !== null || value.bytes !== 0)) {
    errors.push(`${label} absent snapshots cannot have content`);
  }
}

function footprintDigest(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifest_digest;
  return sha256Digest(unsigned);
}

function validateFootprint(manifest) {
  const errors = [];
  if (!exact(manifest, FOOTPRINT_FIELDS, 'footprint', errors)) return errors;
  if (manifest.contract_version !== CONTRACT_VERSION) errors.push('footprint contract_version is unsupported');
  if (manifest.kind !== 'citadel_footprint_manifest') errors.push('footprint kind is invalid');
  if (!Array.isArray(manifest.entries)) errors.push('footprint entries must be an array');
  else {
    const ids = new Set();
    const paths = new Set();
    for (const [index, entry] of manifest.entries.entries()) {
      const label = `footprint.entries[${index}]`;
      if (!exact(entry, FOOTPRINT_ENTRY_FIELDS, label, errors)) continue;
      if (typeof entry.entry_id !== 'string' || ids.has(entry.entry_id)) errors.push(`${label}.entry_id is invalid or duplicate`);
      ids.add(entry.entry_id);
      if (!safeRelative(entry.path) || paths.has(entry.path)) errors.push(`${label}.path is unsafe or duplicate`);
      paths.add(entry.path);
      if (entry.kind !== 'file') errors.push(`${label}.kind must be file`);
      if (!OWNERSHIP.includes(entry.ownership)) errors.push(`${label}.ownership is invalid`);
      if (typeof entry.required !== 'boolean') errors.push(`${label}.required must be boolean`);
      validateSnapshot(entry.before, `${label}.before`, errors);
      if (!DIGEST.test(entry.installed_digest)) errors.push(`${label}.installed_digest is invalid`);
      if (!Number.isInteger(entry.installed_bytes) || entry.installed_bytes < 0) errors.push(`${label}.installed_bytes is invalid`);
      if (!['delete_if_exact', 'restore_preimage_if_exact', 'retain'].includes(entry.removal)) errors.push(`${label}.removal is invalid`);
      if (entry.preimage_base64 !== null && typeof entry.preimage_base64 !== 'string') errors.push(`${label}.preimage_base64 is invalid`);
      if (entry.removal === 'restore_preimage_if_exact') {
        if (!entry.before.exists || typeof entry.preimage_base64 !== 'string') {
          errors.push(`${label} restore removal requires an encoded pre-image`);
        } else {
          const preimage = Buffer.from(entry.preimage_base64, 'base64');
          if (preimage.toString('base64') !== entry.preimage_base64
              || digestBytes(preimage) !== entry.before.digest || preimage.length !== entry.before.bytes) {
            errors.push(`${label} pre-image does not match before`);
          }
        }
      }
    }
  }
  if (manifest.manifest_digest !== footprintDigest(manifest)) errors.push('footprint manifest_digest does not match');
  return errors;
}

function planDigest(plan) {
  const unsigned = { ...plan, confirmation: { ...plan.confirmation } };
  delete unsigned.plan_digest;
  delete unsigned.confirmation.token;
  return sha256Digest(unsigned);
}

function confirmationToken(digest) {
  return `apply-${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

function validateIssue(issue, label, errors) {
  if (!exact(issue, ['code', 'message', 'paths'], label, errors)) return;
  if (typeof issue.code !== 'string' || typeof issue.message !== 'string') errors.push(`${label} code/message are invalid`);
  if (!Array.isArray(issue.paths) || issue.paths.some((item) => typeof item !== 'string')) errors.push(`${label}.paths is invalid`);
}

function validateTarget(value, label, errors, nullable = false) {
  if (nullable && value === null) return;
  const fields = ['root', 'git_root', 'head', 'branch', 'dirty_digest', 'dirty_paths', 'preflight_digest'];
  if (!exact(value, fields, label, errors)) return;
  if (typeof value.root !== 'string'
      || (value.git_root !== null && typeof value.git_root !== 'string')) errors.push(`${label} roots are invalid`);
  if (value.head !== null && typeof value.head !== 'string') errors.push(`${label}.head is invalid`);
  if (value.branch !== null && typeof value.branch !== 'string') errors.push(`${label}.branch is invalid`);
  if (!DIGEST.test(value.dirty_digest || '') || !DIGEST.test(value.preflight_digest || '')) errors.push(`${label} digests are invalid`);
  if (!Array.isArray(value.dirty_paths) || value.dirty_paths.some((item) => typeof item !== 'string')) errors.push(`${label}.dirty_paths is invalid`);
}

function validateSource(value, label, errors, nullable = false) {
  if (nullable && value === null) return;
  const fields = ['kind', 'root', 'version', 'package_digest', 'template_digest', 'git_head', 'git_dirty_digest', 'source_digest'];
  if (!exact(value, fields, label, errors)) return;
  if (value.kind !== 'local-path' || typeof value.root !== 'string' || typeof value.version !== 'string') errors.push(`${label} identity is invalid`);
  for (const field of ['package_digest', 'template_digest']) {
    if (value[field] !== null && !DIGEST.test(value[field])) errors.push(`${label}.${field} is invalid`);
  }
  if (value.git_head !== null && typeof value.git_head !== 'string') errors.push(`${label}.git_head is invalid`);
  if (!DIGEST.test(value.git_dirty_digest || '') || !DIGEST.test(value.source_digest || '')) errors.push(`${label} digests are invalid`);
}

function validateRuntime(value, label, errors) {
  if (!exact(value, ['adapter', 'name', 'scope', 'version'], label, errors)) return;
  if (value.adapter !== 'local-path' || value.scope !== 'project'
      || typeof value.name !== 'string' || typeof value.version !== 'string') errors.push(`${label} is invalid`);
}

function validateGeneration(value, label, errors, nullable = false) {
  if (nullable && value === null) return;
  if (!exact(value, ['generation_id', 'version', 'source_digest', 'state_schema', 'pointer_path'], label, errors)) return;
  if (!/^generation-[a-f0-9]{24}$/.test(value.generation_id || '')
      || typeof value.version !== 'string'
      || (value.source_digest !== null && !DIGEST.test(value.source_digest))
      || typeof value.state_schema !== 'string' || !safeRelative(value.pointer_path)) {
    errors.push(`${label} is invalid`);
  }
}

function validatePredecessor(value, label, errors, nullable = false) {
  if (nullable && value === null) return;
  if (!exact(value, ['receipt_id', 'receipt_digest'], label, errors)) return;
  if (!/^receipt-[a-f0-9]{24}$/.test(value.receipt_id || '')
      || !DIGEST.test(value.receipt_digest || '')) errors.push(`${label} is invalid`);
}

function validateProjection(value, label, errors) {
  if (!exact(value, ['runtime', 'status', 'proposed_effects'], label, errors)) return;
  if (!['claude', 'copilot', 'codex'].includes(value.runtime) || typeof value.status !== 'string'
      || !Array.isArray(value.proposed_effects)) errors.push(`${label} identity is invalid`);
  else value.proposed_effects.forEach((effect, index) => {
    const effectLabel = `${label}.proposed_effects[${index}]`;
    if (!exact(effect, ['runtime', 'surface', 'path', 'action', 'ownership', 'before', 'proposed', 'removal'], effectLabel, errors)) return;
    if (effect.runtime !== value.runtime || typeof effect.surface !== 'string'
        || !['create', 'replace', 'manual_review', 'external_registration'].includes(effect.action)
        || !OWNERSHIP.includes(effect.ownership)) errors.push(`${effectLabel} identity is invalid`);
    if (effect.action !== 'external_registration' && !safeRelative(effect.path)) errors.push(`${effectLabel}.path is unsafe`);
    if (effect.before !== null) validateSnapshot(effect.before, `${effectLabel}.before`, errors);
    if (effect.proposed !== null) {
      if (exact(effect.proposed, ['digest', 'bytes', 'content_base64'], `${effectLabel}.proposed`, errors)) {
        const content = Buffer.from(effect.proposed.content_base64 || '', 'base64');
        if (!DIGEST.test(effect.proposed.digest || '') || !Number.isInteger(effect.proposed.bytes)
            || content.toString('base64') !== effect.proposed.content_base64
            || content.length !== effect.proposed.bytes || digestBytes(content) !== effect.proposed.digest) {
          errors.push(`${effectLabel}.proposed content is invalid`);
        }
      }
    }
    if (exact(effect.removal, ['strategy', 'evidence_status', 'required_observation'], `${effectLabel}.removal`, errors)) {
      if (!['planned', 'unknown'].includes(effect.removal.evidence_status)
          || typeof effect.removal.strategy !== 'string'
          || typeof effect.removal.required_observation !== 'string') errors.push(`${effectLabel}.removal is invalid`);
    }
  });
}

function validatePlanVerification(value, label, errors) {
  if (!isObject(value) || !['file_digest', 'absent'].includes(value.check)) {
    errors.push(`${label} is invalid`);
    return;
  }
  const fields = value.check === 'file_digest'
    ? ['check', 'path', 'required', 'digest', 'bytes'] : ['check', 'path'];
  if (!exact(value, fields, label, errors)) return;
  if (!safeRelative(value.path)) errors.push(`${label}.path is unsafe`);
  if (value.check === 'file_digest'
      && (typeof value.required !== 'boolean' || !DIGEST.test(value.digest || '')
        || !Number.isInteger(value.bytes) || value.bytes < 0)) errors.push(`${label} expectation is invalid`);
}

function validatePlan(plan) {
  const errors = [];
  if (!exact(plan, PLAN_FIELDS, 'plan', errors)) return errors;
  if (plan.contract_version !== CONTRACT_VERSION) errors.push('plan contract_version is unsupported');
  if (plan.kind !== 'citadel_adoption_plan') errors.push('plan kind is invalid');
  if (!OPERATIONS.includes(plan.operation)) errors.push('plan operation is invalid');
  if (typeof plan.plan_id !== 'string' || !/^plan-[a-f0-9]{24}$/.test(plan.plan_id)) errors.push('plan_id is invalid');
  if (!timestamp(plan.created_at)) errors.push('created_at must be canonical ISO time');
  validateTarget(plan.target, 'target', errors, true);
  validateSource(plan.source, 'source', errors, true);
  validateRuntime(plan.runtime, 'runtime', errors);
  const migrationErrors = validateMigration(plan.migration);
  migrationErrors.forEach((error) => errors.push(error));
  validateGeneration(plan.generation, 'generation', errors, true);
  validatePredecessor(plan.predecessor, 'predecessor', errors, true);
  if (!Array.isArray(plan.runtime_projections)) errors.push('runtime_projections must be an array');
  else plan.runtime_projections.forEach((item, index) => validateProjection(item, `runtime_projections[${index}]`, errors));
  if (!PLAN_STATUSES.includes(plan.status)) errors.push('plan status is invalid');
  for (const field of ['blockers', 'warnings']) {
    if (!Array.isArray(plan[field])) errors.push(`${field} must be an array`);
    else plan[field].forEach((item, index) => validateIssue(item, `${field}[${index}]`, errors));
  }
  if (exact(plan.confirmation, ['required', 'reasons', 'token'], 'confirmation', errors)) {
    if (typeof plan.confirmation.required !== 'boolean'
        || !Array.isArray(plan.confirmation.reasons)
        || plan.confirmation.reasons.some((item) => typeof item !== 'string')) errors.push('confirmation is invalid');
  }
  if (!Array.isArray(plan.effects)) errors.push('effects must be an array');
  else {
    const effectIds = new Set();
    for (const [index, effect] of plan.effects.entries()) {
    const label = `effects[${index}]`;
    if (!exact(effect, EFFECT_FIELDS, label, errors)) continue;
    if (typeof effect.effect_id !== 'string' || effectIds.has(effect.effect_id) || !ACTIONS.includes(effect.action)) errors.push(`${label} identity/action is invalid`);
    effectIds.add(effect.effect_id);
    if (!safeRelative(effect.path) || !OWNERSHIP.includes(effect.ownership)) errors.push(`${label} path/ownership is invalid`);
    validateSnapshot(effect.before, `${label}.before`, errors);
    if (effect.action === 'create' || effect.action === 'replace') {
      if (!exact(effect.after, ['digest', 'bytes'], `${label}.after`, errors)) continue;
      if (!DIGEST.test(effect.after.digest) || !Number.isInteger(effect.after.bytes) || effect.after.bytes < 0) errors.push(`${label}.after is invalid`);
      if (typeof effect.content_base64 !== 'string') errors.push(`${label}.content_base64 is required`);
      else {
        const content = Buffer.from(effect.content_base64, 'base64');
        if (content.toString('base64') !== effect.content_base64
            || digestBytes(content) !== effect.after.digest || content.length !== effect.after.bytes) {
          errors.push(`${label} content does not match after`);
        }
      }
      if (effect.action === 'create' && effect.before.exists) errors.push(`${label} create effect requires an absent pre-image`);
      if (effect.action === 'replace' && !effect.before.exists) errors.push(`${label} replace effect requires an existing pre-image`);
    } else {
      if (!effect.before.exists) errors.push(`${label} remove effect requires an existing pre-image`);
      if (effect.after !== null || effect.content_base64 !== null) errors.push(`${label} remove effect must have null output`);
    }
    }
  }
  errors.push(...validateFootprint(plan.footprint_preview));
  if (!Array.isArray(plan.verification)) errors.push('verification must be an array');
  else plan.verification.forEach((item, index) => validatePlanVerification(item, `verification[${index}]`, errors));
  if (!exact(plan.rollback, ['strategy', 'reversible'], 'rollback', errors)) return errors;
  if (plan.rollback?.strategy !== 'preimage-journal' || typeof plan.rollback?.reversible !== 'boolean') errors.push('rollback contract is invalid');
  if (plan.archive !== null) {
    if (exact(plan.archive, ['path', 'digest', 'content_base64'], 'archive', errors)) {
      const archive = Buffer.from(plan.archive.content_base64 || '', 'base64');
      if (!safeRelative(plan.archive.path) || !DIGEST.test(plan.archive.digest || '')
          || archive.toString('base64') !== plan.archive.content_base64
          || digestBytes(archive) !== plan.archive.digest) errors.push('archive content is invalid');
    }
  }
  if (!DIGEST.test(plan.plan_digest) || plan.plan_digest !== planDigest(plan)) errors.push('plan_digest does not match');
  if (plan.confirmation?.token !== confirmationToken(plan.plan_digest)) errors.push('confirmation token does not match plan');
  if (plan.status === 'blocked' !== (plan.blockers.length > 0)) errors.push('blocked status must match blockers');
  if (plan.status === 'ready' && plan.confirmation.required) errors.push('ready plans cannot require confirmation');
  if (plan.status === 'confirmation_required' && !plan.confirmation.required) errors.push('confirmation_required plans must require confirmation');
  return errors;
}

function receiptDigest(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receipt_digest;
  return sha256Digest(unsigned);
}

function validateObservedEffect(value, label, errors) {
  if (!exact(value, ['effect_id', 'action', 'path', 'before', 'after', 'state'], label, errors)) return;
  if (typeof value.effect_id !== 'string' || !ACTIONS.includes(value.action)
      || !safeRelative(value.path) || value.state !== 'completed') errors.push(`${label} identity is invalid`);
  validateSnapshot(value.before, `${label}.before`, errors);
  validateSnapshot(value.after, `${label}.after`, errors);
}

function validateReceiptVerification(value, label, errors) {
  if (!exact(value, ['path', 'required', 'exact', 'observed'], label, errors)) return;
  if (!safeRelative(value.path) || typeof value.required !== 'boolean'
      || typeof value.exact !== 'boolean') errors.push(`${label} result is invalid`);
  validateSnapshot(value.observed, `${label}.observed`, errors);
}

function validateReceipt(receipt) {
  const errors = [];
  if (!exact(receipt, RECEIPT_FIELDS, 'receipt', errors)) return errors;
  if (receipt.contract_version !== CONTRACT_VERSION || receipt.kind !== 'citadel_adoption_receipt') errors.push('receipt version/kind is invalid');
  if (!/^receipt-[a-f0-9]{24}$/.test(receipt.receipt_id || '')) errors.push('receipt_id is invalid');
  if (!/^operation-[a-f0-9]{24}$/.test(receipt.operation_id || '')
      || !/^plan-[a-f0-9]{24}$/.test(receipt.plan_id || '')) errors.push('receipt operation/plan identity is invalid');
  if (!DIGEST.test(receipt.plan_digest) || !DIGEST.test(receipt.journal_head)) errors.push('receipt plan/journal digest is invalid');
  validateSource(receipt.source, 'receipt.source', errors, true);
  validateTarget(receipt.target, 'receipt.target', errors);
  validateRuntime(receipt.runtime, 'receipt.runtime', errors);
  validateMigration(receipt.migration).forEach((error) => errors.push(error));
  validateGeneration(receipt.generation, 'receipt.generation', errors, true);
  validatePredecessor(receipt.predecessor, 'receipt.predecessor', errors, true);
  if (!Array.isArray(receipt.runtime_projections)) errors.push('receipt runtime_projections must be an array');
  else receipt.runtime_projections.forEach((item, index) => validateProjection(item, `receipt.runtime_projections[${index}]`, errors));
  errors.push(...validateFootprint(receipt.footprint));
  if (!Array.isArray(receipt.observed_effects)) errors.push('receipt observed_effects must be an array');
  else receipt.observed_effects.forEach((item, index) => validateObservedEffect(item, `receipt.observed_effects[${index}]`, errors));
  if (!Array.isArray(receipt.verification)) errors.push('receipt verification must be an array');
  else receipt.verification.forEach((item, index) => validateReceiptVerification(item, `receipt.verification[${index}]`, errors));
  if (receipt.state !== 'active') errors.push('receipt state must be active');
  if (!timestamp(receipt.issued_at)) errors.push('receipt issued_at is invalid');
  if (receipt.receipt_digest !== receiptDigest(receipt)) errors.push('receipt_digest does not match');
  return errors;
}

function journalEntryDigest(entry) {
  const unsigned = { ...entry };
  delete unsigned.entry_digest;
  return sha256Digest(unsigned);
}

function validateJournalEntry(entry) {
  const errors = [];
  if (!exact(entry, JOURNAL_FIELDS, 'journal entry', errors)) return errors;
  if (entry.contract_version !== CONTRACT_VERSION || entry.kind !== 'citadel_mutation_journal_entry') errors.push('journal version/kind is invalid');
  if (!Number.isInteger(entry.sequence) || entry.sequence < 1) errors.push('journal sequence is invalid');
  if (!/^operation-[a-f0-9]{24}$/.test(entry.operation_id || '')
      || !['operation', 'effect', 'verification', 'doctor', 'receipt', 'recovery'].includes(entry.phase)
      || !['planned', 'completed', 'active', 'retired', 'recovered', 'recovery_required', 'failed'].includes(entry.state)) {
    errors.push('journal identity/phase/state is invalid');
  }
  if (entry.effect_id !== null && typeof entry.effect_id !== 'string') errors.push('journal effect_id is invalid');
  if (entry.reason_code !== null && typeof entry.reason_code !== 'string') errors.push('journal reason_code is invalid');
  if (!timestamp(entry.recorded_at)) errors.push('journal recorded_at is invalid');
  for (const field of ['payload_digest', 'entry_digest']) if (!DIGEST.test(entry[field] || '')) errors.push(`${field} is invalid`);
  for (const field of ['evidence_digest', 'previous_digest']) if (entry[field] !== null && !DIGEST.test(entry[field])) errors.push(`${field} is invalid`);
  if (entry.entry_digest !== journalEntryDigest(entry)) errors.push('journal entry_digest does not match');
  return errors;
}

function assertValid(value, validate, label) {
  const errors = validate(value);
  if (errors.length) throw new TypeError(`Invalid ${label}: ${errors.join('; ')}`);
  return value;
}

module.exports = Object.freeze({
  ACTIONS, CONTRACT_VERSION, DIGEST, JOURNAL_FIELDS, OPERATIONS, OWNERSHIP,
  PLAN_STATUSES, assertValid, confirmationToken, digestBytes, footprintDigest,
  journalEntryDigest, planDigest, receiptDigest, safeRelative, validateFootprint,
  validateJournalEntry, validatePlan, validateReceipt,
});
