#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const control = require('../core/control-plane');
const operations = require('../core/operations');

const BASE_TIME = '2026-07-30T12:00:00.000Z';
const EXPIRES = '2026-08-30T12:00:00.000Z';

function clock() {
  let seconds = 0;
  return () => new Date(Date.parse(BASE_TIME) + seconds++ * 1000).toISOString();
}

function request(method, payload, options = {}) {
  const kind = method === 'operations.submit' || method === 'intents.submit' ? 'command' : 'query';
  return {
    control_plane_api_version: 1,
    request_id: options.requestId || `request-${method.replace(/\./g, '-')}`,
    kind,
    method,
    payload,
    sent_at: options.sentAt || BASE_TIME,
    traceparent: options.traceparent || null,
    idempotency_key: kind === 'command' ? options.idempotencyKey : null,
    expected_revision: method === 'intents.submit' ? options.expectedRevision : null,
  };
}

function proofPolicy(operationId, objectiveDigest, verifierDigests) {
  return {
    control_plane_contract_version: '0.1',
    kind: 'proof_policy',
    proof_policy_id: `proof-${operationId}`,
    operation_id: operationId,
    objective_digest: objectiveDigest,
    requirements: [
      {
        requirement_id: 'proof-edit',
        step_id: 'edit',
        evidence_types: ['diff'],
        verifier_policy: 'deterministic',
        verifier_contract_digest: verifierDigests.edit,
        required_status: 'passed',
      },
      {
        requirement_id: 'proof-verify',
        step_id: 'verify',
        evidence_types: ['test'],
        verifier_policy: 'deterministic',
        verifier_contract_digest: verifierDigests.verify,
        required_status: 'passed',
      },
    ],
    missing_status: 'unknown',
    receipt_signature_required: true,
    created_at: BASE_TIME,
  };
}

function fixture(operationId, authorityPrivateKey, keyId = 'external-key', overrides = {}) {
  const objectiveDigest = operations.sha256Digest({ objective: operationId });
  const verifierDigests = {
    edit: operations.sha256Digest({ verifier: 'diff-v1' }),
    verify: operations.sha256Digest({ verifier: 'test-v1' }),
  };
  const policy = proofPolicy(operationId, objectiveDigest, verifierDigests);
  const authorityPolicyDigest = operations.sha256Digest({ authority_policy: 'external-v1' });
  const operation = {
    protocol_version: '0.1',
    kind: 'operation_spec',
    operation_id: operationId,
    title: 'Repair stale documentation example',
    objective_digest: objectiveDigest,
    step_ids: ['edit', 'verify'],
    policy_digests: [operations.sha256Digest(policy), authorityPolicyDigest],
    created_at: BASE_TIME,
  };
  const scopeDigest = overrides.scopeDigest || operations.sha256Digest({ scope: 'docs-only' });
  const grant = {
    control_plane_contract_version: '0.1',
    kind: 'authority_grant',
    grant_id: overrides.grantId || `grant-${operationId}`,
    issuer_id: 'external-plane',
    actor_id: 'operator-one',
    operation_digest: operations.sha256Digest(operation),
    scope_digest: overrides.grantScopeDigest || scopeDigest,
    permitted_actions: ['start', 'pause', 'resume', 'cancel', 'approve', 'reject', 'retry'],
    issued_at: overrides.issuedAt || BASE_TIME,
    expires_at: overrides.expiresAt || EXPIRES,
    nonce: overrides.nonce || `nonce-${operationId}`,
  };
  const envelope = control.createAuthorityEnvelope(grant, authorityPrivateKey, keyId);
  return {
    verifierDigests,
    operation,
    policy,
    scopeDigest,
    envelope,
    submission: {
      control_plane_contract_version: '0.1',
      kind: 'external_operation_submission',
      submission_id: `submission-${operationId}`,
      adapter_id: 'external-sample',
      operation_spec: operation,
      proof_policy: policy,
      scope_digest: scopeDigest,
      authority_policy_digest: authorityPolicyDigest,
      authority_grant_envelope: envelope,
      submitted_at: BASE_TIME,
    },
  };
}

function intentCommand(fixtureValue, action, intentId, authorityPrivateKey, keyId = 'external-key') {
  const grant = {
    ...fixtureValue.envelope.grant,
    grant_id: `grant-${intentId}`,
    nonce: `nonce-${intentId}`,
  };
  const envelope = control.createAuthorityEnvelope(grant, authorityPrivateKey, keyId);
  return {
    control_plane_contract_version: '0.1',
    kind: 'external_intent_command',
    command_id: `command-${intentId}`,
    intent: {
      protocol_version: '0.1',
      kind: 'intent',
      intent_id: intentId,
      operation_id: fixtureValue.operation.operation_id,
      action,
      actor_id: 'operator-one',
      scope_digest: fixtureValue.scopeDigest,
      created_at: grant.issued_at,
      expires_at: grant.expires_at,
    },
    authority_grant_envelope: envelope,
    reason_code: 'OPERATOR_REQUESTED',
    reason_digest: operations.sha256Digest({ reason: action }),
  };
}

function executionInput(fixtureValue, run, includeVerify = true) {
  const completedAt = run.started_at;
  const attempts = [
    {
      protocol_version: '0.1', kind: 'step_attempt', attempt_id: 'attempt-edit',
      run_id: run.run_id, step_id: 'edit', attempt_number: 1, status: 'passed',
      started_at: run.started_at, completed_at: completedAt,
      evidence_ids: ['evidence-edit'], failure_code: null,
    },
  ];
  const evidence = [
    {
      protocol_version: '0.1', kind: 'evidence_envelope', evidence_id: 'evidence-edit',
      run_id: run.run_id, step_attempt_id: 'attempt-edit', evidence_type: 'diff',
      status: 'passed', subject_digest: operations.requiredStepSubject(fixtureValue.operation, 'edit'),
      artifact_digest: operations.sha256Digest({ artifact: 'diff' }),
      recorded_at: completedAt, redacted: true,
    },
  ];
  const bindings = [{
    evidence_id: 'evidence-edit',
    verifier_contract_digest: fixtureValue.verifierDigests.edit,
  }];
  if (includeVerify) {
    attempts.push({
      protocol_version: '0.1', kind: 'step_attempt', attempt_id: 'attempt-verify',
      run_id: run.run_id, step_id: 'verify', attempt_number: 1, status: 'passed',
      started_at: run.started_at, completed_at: completedAt,
      evidence_ids: ['evidence-verify'], failure_code: null,
    });
    evidence.push({
      protocol_version: '0.1', kind: 'evidence_envelope', evidence_id: 'evidence-verify',
      run_id: run.run_id, step_attempt_id: 'attempt-verify', evidence_type: 'test',
      status: 'passed', subject_digest: operations.requiredStepSubject(fixtureValue.operation, 'verify'),
      artifact_digest: operations.sha256Digest({ artifact: 'test' }),
      recorded_at: completedAt, redacted: true,
    });
    bindings.push({
      evidence_id: 'evidence-verify',
      verifier_contract_digest: fixtureValue.verifierDigests.verify,
    });
  }
  return {
    run: {
      ...run,
      status: 'passed',
      completed_at: completedAt,
      step_attempt_ids: attempts.map((attempt) => attempt.attempt_id),
    },
    step_attempts: attempts,
    evidence_envelopes: evidence,
    evidence_bindings: bindings,
    handoffs: [],
    execution_plan_digest: null,
  };
}

function reportCheck(checks, name, passed, detail) {
  checks.push({ name, status: passed ? 'passed' : 'failed', detail });
}

function runConformance() {
  const checks = [];
  const authorityKeys = crypto.generateKeyPairSync('ed25519');
  const wrongKeys = crypto.generateKeyPairSync('ed25519');
  const proofKeys = crypto.generateKeyPairSync('ed25519');
  const serviceOptions = {
    now: clock(),
    installationId: 'reference-adapter',
    authorityTrustedKeys: new Map([['external-key', authorityKeys.publicKey]]),
    proofPrivateKey: proofKeys.privateKey,
    proofKeyId: 'citadel-proof',
    proofIssuerId: 'citadel-reference',
  };
  const service = control.createControlPlaneService(serviceOptions);

  const handshake = service.handle(request('handshake', {
    supported_control_plane_contract_versions: ['0.1'],
    supported_operations_protocol_versions: ['0.1'],
  }, { requestId: 'request-handshake' }));
  reportCheck(checks, 'handshake-version', handshake.outcome === 'accepted', handshake.reason_code);
  const unsupported = service.handle(request('handshake', {
    supported_control_plane_contract_versions: ['9.0'],
    supported_operations_protocol_versions: ['0.1'],
  }, { requestId: 'request-unsupported' }));
  reportCheck(checks, 'handshake-unsupported', unsupported.outcome === 'blocked', unsupported.reason_code);

  const main = fixture('operation-docs', authorityKeys.privateKey);
  const submitRequest = request('operations.submit', main.submission, {
    requestId: 'request-submit', idempotencyKey: 'idem-submit',
  });
  const submitted = service.handle(submitRequest);
  const eventCountAfterSubmit = service.eventCount;
  const replayedSubmit = service.handle({ ...submitRequest, request_id: 'request-submit-replay' });
  reportCheck(checks, 'submit-authorized', submitted.outcome === 'accepted', submitted.reason_code);
  reportCheck(checks, 'idempotency-same-request',
    replayedSubmit.outcome === 'accepted' && service.eventCount === eventCountAfterSubmit,
    replayedSubmit.reason_code);
  const reused = service.handle({
    ...submitRequest,
    request_id: 'request-submit-conflict',
    payload: { ...main.submission, adapter_id: 'different-adapter' },
  });
  reportCheck(checks, 'idempotency-different-request', reused.outcome === 'conflict', reused.reason_code);

  const wrong = fixture('operation-wrong', wrongKeys.privateKey, 'external-key');
  const wrongService = control.createControlPlaneService(serviceOptions);
  const wrongResult = wrongService.handle(request('operations.submit', wrong.submission, {
    requestId: 'request-wrong', idempotencyKey: 'idem-wrong',
  }));
  reportCheck(checks, 'authority-wrong-signer', wrongResult.outcome === 'rejected', wrongResult.reason_code);

  const untrusted = fixture(
    'operation-untrusted',
    authorityKeys.privateKey,
    'untrusted-external-key',
  );
  const untrustedService = control.createControlPlaneService(serviceOptions);
  const untrustedResult = untrustedService.handle(request('operations.submit', untrusted.submission, {
    requestId: 'request-untrusted', idempotencyKey: 'idem-untrusted',
  }));
  reportCheck(
    checks,
    'authority-untrusted-key-id',
    untrustedResult.outcome === 'blocked'
      && untrustedResult.reason_code === 'AUTHORITY_SIGNER_NOT_TRUSTED',
    untrustedResult.reason_code,
  );

  const expired = fixture('operation-expired', authorityKeys.privateKey, 'external-key', {
    issuedAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-07-01T00:00:00.000Z',
  });
  const expiredService = control.createControlPlaneService(serviceOptions);
  const expiredResult = expiredService.handle(request('operations.submit', expired.submission, {
    requestId: 'request-expired', idempotencyKey: 'idem-expired',
  }));
  reportCheck(checks, 'authority-expired', expiredResult.outcome === 'rejected', expiredResult.reason_code);

  const mismatched = fixture('operation-scope', authorityKeys.privateKey, 'external-key', {
    grantScopeDigest: operations.sha256Digest({ scope: 'other' }),
  });
  const scopeService = control.createControlPlaneService(serviceOptions);
  const scopeResult = scopeService.handle(request('operations.submit', mismatched.submission, {
    requestId: 'request-scope', idempotencyKey: 'idem-scope',
  }));
  reportCheck(checks, 'authority-scope', scopeResult.outcome === 'blocked', scopeResult.reason_code);

  const startCommand = intentCommand(main, 'start', 'intent-start', authorityKeys.privateKey);
  const startRequest = request('intents.submit', startCommand, {
    requestId: 'request-start', idempotencyKey: 'idem-start', expectedRevision: 0,
  });
  const started = service.handle(startRequest);
  const eventsAfterStart = service.eventCount;
  const startReplay = service.handle({ ...startRequest, request_id: 'request-start-replay' });
  reportCheck(checks, 'intent-consumed', started.outcome === 'accepted' && started.current_revision === 1, started.reason_code);
  reportCheck(checks, 'intent-idempotent',
    startReplay.outcome === 'accepted' && service.eventCount === eventsAfterStart, startReplay.reason_code);
  const pause = intentCommand(main, 'pause', 'intent-pause', authorityKeys.privateKey);
  const stale = service.handle(request('intents.submit', pause, {
    requestId: 'request-stale', idempotencyKey: 'idem-stale', expectedRevision: 0,
  }));
  reportCheck(checks, 'optimistic-revision', stale.outcome === 'conflict', stale.reason_code);

  const current = service.handle(request('operations.get', { operation_id: 'operation-docs' }, {
    requestId: 'request-get',
  }));
  const execution = executionInput(main, current.result.run, true);
  execution.execution_plan_digest = current.result.execution_plan_digest;
  service.recordExecution('operation-docs', execution);
  const proofResponse = service.handle(request('proof.get', { run_id: current.result.run.run_id }, {
    requestId: 'request-proof',
  }));
  const proof = proofResponse.result.proof_bundle;
  const verification = control.verifyProofBundle(proof, {
    trustedKeys: new Map([['citadel-proof', proofKeys.publicKey]]),
    authority: {
      trustedKeys: new Map([['external-key', authorityKeys.publicKey]]),
      now: BASE_TIME,
    },
  });
  reportCheck(checks, 'intent-lineage',
    proof.operation_run.intent_ids.includes('intent-start')
      && proof.accepted_intents.some((intent) => intent.intent_id === 'intent-start'),
    proof.operation_run.intent_ids.join(','));
  reportCheck(checks, 'proof-verified',
    verification.status === 'verified' && verification.proof_status === 'passed',
    verification.reason_code);

  const replayOne = service.handle(request('events.replay', { after_cursor: null, limit: 500 }, {
    requestId: 'request-events-one',
  }));
  const restarted = control.createControlPlaneService({ ...serviceOptions, snapshot: service.snapshot() });
  const replayTwo = restarted.handle(request('events.replay', { after_cursor: null, limit: 500 }, {
    requestId: 'request-events-two',
  }));
  const firstIds = replayOne.result.events.map((event) => event.id);
  const secondIds = replayTwo.result.events.map((event) => event.id);
  reportCheck(checks, 'outbox-restart-replay',
    JSON.stringify(firstIds) === JSON.stringify(secondIds)
      && replayOne.result.next_cursor === replayTwo.result.next_cursor,
    `${firstIds.length} replayable events`);
  const duplicateReplay = restarted.handle(request('events.replay', { after_cursor: null, limit: 500 }, {
    requestId: 'request-events-duplicate',
  }));
  reportCheck(checks, 'at-least-once-deduplication',
    duplicateReplay.result.events[0].id === replayTwo.result.events[0].id,
    duplicateReplay.result.events[0].id);

  const durableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-control-conformance-'));
  try {
    const statePath = path.join(durableRoot, 'control-plane.json');
    const durable = control.createFileControlPlaneAdapter({ ...serviceOptions, statePath });
    const durableFixture = fixture('operation-durable', authorityKeys.privateKey);
    durable.handle(request('operations.submit', durableFixture.submission, {
      requestId: 'request-durable-submit', idempotencyKey: 'idem-durable-submit',
    }));
    const durableStart = intentCommand(
      durableFixture, 'start', 'intent-durable-start', authorityKeys.privateKey,
    );
    durable.handle(request('intents.submit', durableStart, {
      requestId: 'request-durable-start',
      idempotencyKey: 'idem-durable-start',
      expectedRevision: 0,
    }));
    const durableRestart = control.createFileControlPlaneAdapter({ ...serviceOptions, statePath });
    const durableReplay = durableRestart.handle(request('events.replay', {
      after_cursor: 'cursor-1', limit: 500,
    }, { requestId: 'request-durable-events' }));
    const durableSequences = durableReplay.result.events.map((event) => event.data.sequence);
    reportCheck(checks, 'durable-ordered-replay',
      durableReplay.outcome === 'accepted'
        && durableSequences.length > 0
        && durableSequences.every((sequence, index) => sequence === index + 2),
      durableSequences.join(','));
    const ahead = durableRestart.handle(request('events.replay', {
      after_cursor: 'cursor-999', limit: 500,
    }, { requestId: 'request-durable-gap' }));
    reportCheck(checks, 'replay-gap-detection',
      ahead.outcome === 'conflict' && ahead.reason_code === 'REPLAY_CURSOR_AHEAD',
      ahead.reason_code);
  } finally {
    fs.rmSync(durableRoot, { recursive: true, force: true });
  }

  const missing = fixture('operation-missing', authorityKeys.privateKey);
  const missingService = control.createControlPlaneService(serviceOptions);
  missingService.handle(request('operations.submit', missing.submission, {
    requestId: 'request-missing-submit', idempotencyKey: 'idem-missing-submit',
  }));
  const missingStart = intentCommand(missing, 'start', 'intent-missing-start', authorityKeys.privateKey);
  missingService.handle(request('intents.submit', missingStart, {
    requestId: 'request-missing-start', idempotencyKey: 'idem-missing-start', expectedRevision: 0,
  }));
  const missingCurrent = missingService.handle(request('operations.get', { operation_id: 'operation-missing' }, {
    requestId: 'request-missing-get',
  }));
  const missingExecution = executionInput(missing, missingCurrent.result.run, false);
  missingExecution.execution_plan_digest = missingCurrent.result.execution_plan_digest;
  missingService.recordExecution('operation-missing', missingExecution);
  const missingProof = missingService.handle(request('proof.get', { run_id: missingCurrent.result.run.run_id }, {
    requestId: 'request-missing-proof',
  })).result.proof_bundle;
  reportCheck(checks, 'missing-proof-unknown',
    missingProof.proof_evaluation.status === 'unknown'
      && missingProof.execution_receipt_envelope.receipt.status === 'unknown',
    missingProof.proof_evaluation.status);

  const tampered = clone(proof);
  tampered.operation_spec.title = 'Tampered title';
  const tamperResult = control.verifyProofBundle(tampered, {
    trustedKeys: new Map([['citadel-proof', proofKeys.publicKey]]),
    authority: { trustedKeys: new Map([['external-key', authorityKeys.publicKey]]), now: BASE_TIME },
  });
  reportCheck(checks, 'proof-tamper', tamperResult.status === 'invalid', tamperResult.reason_code);

  const privateRequest = {
    ...submitRequest,
    request_id: 'request-private',
    idempotency_key: 'idem-private',
    payload: { ...main.submission, command: 'powershell.exe' },
  };
  const privateResult = service.handle(privateRequest);
  reportCheck(checks, 'privacy-prohibited-key', privateResult.outcome === 'rejected', privateResult.reason_code);

  const passed = checks.every((check) => check.status === 'passed');
  const summary = {
    control_plane_contract_version: '0.1',
    adapter_id: 'reference-adapter',
    status: passed ? 'passed' : 'failed',
    check_count: checks.length,
    passed_count: checks.filter((check) => check.status === 'passed').length,
    failed_count: checks.filter((check) => check.status === 'failed').length,
    checks,
  };
  return Object.freeze({ ...summary, report_digest: operations.sha256Digest(summary) });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

if (require.main === module) {
  const report = runConformance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

module.exports = Object.freeze({
  executionInput,
  fixture,
  intentCommand,
  request,
  runConformance,
});
