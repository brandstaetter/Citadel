'use strict';

const fs = require('fs');
const { assertValid, validatePlan } = require('./contracts');
const { applyPlan, doctor, AdoptionError } = require('./executor');
const { createAdoptionPlan, createLeavePlan, readReceipt } = require('./planner');
const {
  createImportPlan, createRestorePlan, createRollbackPlan, createUpdatePlan,
} = require('./evolution-planner');
const {
  proposeClaudeProjection, proposeCodexProjection, proposeCopilotProjection,
} = require('./projections');
const {
  defaultControlRoot, mirrorReceipt, readLedgerReceipt,
} = require('./ledger');

function loadPlan(file) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return assertValid(plan, validatePlan, 'adoption plan');
}

module.exports = Object.freeze({
  AdoptionError,
  applyPlan,
  createAdoptionPlan,
  createImportPlan,
  createLeavePlan,
  createRestorePlan,
  createRollbackPlan,
  createUpdatePlan,
  defaultControlRoot,
  doctor,
  loadPlan,
  mirrorReceipt,
  proposeClaudeProjection,
  proposeCodexProjection,
  proposeCopilotProjection,
  readLedgerReceipt,
  readReceipt,
});
