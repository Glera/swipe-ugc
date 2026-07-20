import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPERIMENT_WORKER_CONTRACT_DEFINITION,
  EXPERIMENT_WORKER_CONTRACT_DIGEST,
  FEEDBACK_MAX,
  buildWorkerFailure,
  buildWorkerResult,
  canonicalJson,
  digestOf,
  sanitiseModelEvidence,
  validateExperimentFeedback,
  verifyWorkerFailure,
  verifyWorkerInput,
  verifyWorkerResult,
} from '../worker/result-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The wire golden (and in the publication tests, the terminal parser) are
// owned by the private swipe-generator repo. Standalone CI cannot check it
// out, so these cross-repo contract tests run wherever the two repos sit side
// by side: developer machines and the generator-side CI, which checkouts the
// public swipe-ugc at a pinned ref. Skip honestly instead of crashing at
// import time.
const SIBLING_GENERATOR = path.resolve(here, '..', '..', 'swipe-generator');
const SIBLING_SKIP = existsSync(SIBLING_GENERATOR)
  ? false
  : 'sibling swipe-generator absent (private repo, not checked out in standalone CI)';
const t = (name, fn) => test(name, { skip: SIBLING_SKIP }, fn);

const goldenPath = path.resolve(
  here,
  '..',
  '..',
  'swipe-generator',
  'test',
  'fixtures',
  'experiment-worker-wire-v1.golden.json',
);
const goldenBytes = SIBLING_SKIP ? null : readFileSync(goldenPath);
const golden = SIBLING_SKIP ? null : JSON.parse(goldenBytes.toString('utf8'));

function runtimeFields(result = golden.result) {
  const { feedback: _feedback, ...concept } = result.concept;
  return {
    title: result.title,
    concept,
    autoplayPassed: result.autoplayPassed,
    autoplayOutcome: structuredClone(result.autoplayOutcome),
    wallTimeMs: result.wallTimeMs,
    agentInvocations: result.agentInvocations,
    playtestRuns: result.playtestRuns,
    conformance: structuredClone(result.conformance),
    autoplay: structuredClone(result.autoplay),
    files: [...result.files],
    agentSummary: result.agentSummary,
    createdAt: result.createdAt,
    coverBytes: result.coverBytes,
    artifact: structuredClone(result.artifact),
  };
}

function resignResult(mutate) {
  const { resultDigest: _digest, ...body } = structuredClone(golden.result);
  mutate(body);
  return { ...body, resultDigest: digestOf(body) };
}

function resignFailure(mutate) {
  const { failureDigest: _digest, ...body } = structuredClone(golden.failure);
  mutate(body);
  return { ...body, failureDigest: digestOf(body) };
}

t('one generator-owned golden freezes contract, input, RESULT, ERROR and redaction', () => {
  assert.equal(
    createHash('sha256').update(goldenBytes).digest('hex'),
    'c86959357c579638fe0b81f7c5e863a2c011c86ae2a92dacd10c965534d84587',
  );
  assert.deepEqual(EXPERIMENT_WORKER_CONTRACT_DEFINITION, golden.contractDefinition);
  assert.equal(EXPERIMENT_WORKER_CONTRACT_DIGEST, golden.expectedContractDigest);
  assert.deepEqual(verifyWorkerInput(golden.input), golden.input);
  assert.deepEqual(verifyWorkerResult(golden.result, golden.input), golden.result);
  assert.deepEqual(verifyWorkerFailure(golden.failure, golden.input), golden.failure);
  assert.deepEqual(buildWorkerResult(runtimeFields(), golden.input), golden.result);
  assert.deepEqual(
    buildWorkerFailure({
      input: golden.input,
      code: golden.failure.code,
      message: golden.failure.message,
    }),
    golden.failure,
  );
  for (const vector of golden.redactionVectors) {
    assert.equal(sanitiseModelEvidence(vector.raw, vector.limit), vector.redacted);
    assert.equal(sanitiseModelEvidence(vector.redacted, vector.limit), vector.redacted);
  }
});

t('public contract definition is recursively frozen and clones verifier key arrays', () => {
  const assertDeepFrozen = (value) => {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    for (const nested of Object.values(value)) assertDeepFrozen(nested);
  };
  assertDeepFrozen(EXPERIMENT_WORKER_CONTRACT_DEFINITION);
  assert.throws(
    () => EXPERIMENT_WORKER_CONTRACT_DEFINITION.keys.input.push('forged'),
    TypeError,
  );
  const source = readFileSync(path.join(here, '..', 'worker', 'result-contract.mjs'), 'utf8');
  for (const [field, table] of [
    ['input', 'INPUT_KEYS'], ['request', 'REQUEST_KEYS'], ['attempt', 'ATTEMPT_KEYS'],
    ['model', 'MODEL_KEYS'], ['parent', 'PARENT_KEYS'], ['baseline', 'BASELINE_KEYS'],
    ['worker', 'WORKER_KEYS'], ['parentEvidence', 'EVIDENCE_KEYS'], ['result', 'RESULT_KEYS'],
    ['resultParent', 'RESULT_PARENT_KEYS'], ['artifact', 'ARTIFACT_KEYS'],
    ['concept', 'CONCEPT_KEYS'], ['conformance', 'CONFORMANCE_KEYS'],
    ['autoplay', 'AUTOPLAY_KEYS'], ['failure', 'FAILURE_KEYS'],
  ]) {
    assert.ok(source.includes(`${field}: [...${table}]`), `${field} must clone ${table}`);
  }
  assert.deepEqual(verifyWorkerResult(golden.result, golden.input), golden.result);
});

t('input and output bindings fail closed under re-signing', () => {
  for (const mutate of [
    (body) => { body.attemptUid = '10000000-0000-4000-8000-000000000099'; },
    (body) => { body.jobId = '10000000-0000-4000-8000-000000000099'; },
    (body) => { body.modelExecutionReceiptId = '10000000-0000-4000-8000-000000000099'; },
    (body) => { body.testSeed += 1; },
    (body) => { body.playtestRuns = body.autoplay.runNumber === 1 ? 2 : 1; },
    (body) => { body.files = [...body.files].reverse(); },
    (body) => { body.agentSummary = 'Bearer secret-worker-token'; },
    (body) => { body.autoplay.runNumber = 3; },
    (body) => { body.conformance = { forged: true }; },
  ]) {
    assert.throws(() => verifyWorkerResult(resignResult(mutate), golden.input));
  }
});

function makeUnproven(body) {
  body.autoplayPassed = false;
  body.autoplayOutcome = { budgetSeconds: 150, proven: false, reason: 'budget_exhausted', runs: 2 };
  body.playtestRuns = 2;
  body.autoplay = null;
}

t('a marked-unproven RESULT is first-class and re-verifies through the contract', () => {
  const unproven = resignResult(makeUnproven);
  assert.deepEqual(verifyWorkerResult(unproven, golden.input), unproven);
  assert.equal(unproven.autoplayPassed, false);
  assert.equal(unproven.autoplay, null);
  assert.deepEqual(unproven.autoplayOutcome, {
    budgetSeconds: 150, proven: false, reason: 'budget_exhausted', runs: 2,
  });
});

t('autoplay outcome and metrics must agree, in both proven and unproven directions', () => {
  for (const mutate of [
    // unproven outcome but win metrics still present
    (body) => { makeUnproven(body); body.autoplay = { durationMs: 11830, rafFrames: 710, runNumber: 2, visualStates: 4 }; },
    // proven outcome but no win metrics
    (body) => { body.autoplay = null; },
    // autoplayPassed disagrees with outcome.proven
    (body) => { body.autoplayPassed = false; },
    // proven with the wrong reason
    (body) => { body.autoplayOutcome = { ...body.autoplayOutcome, reason: 'budget_exhausted' }; },
    // unproven with the wrong reason
    (body) => { makeUnproven(body); body.autoplayOutcome = { ...body.autoplayOutcome, reason: 'win_proven' }; },
    // playtestRuns disagrees with outcome.runs
    (body) => { makeUnproven(body); body.playtestRuns = 1; },
    // budgetSeconds out of bounds
    (body) => { makeUnproven(body); body.autoplayOutcome = { ...body.autoplayOutcome, budgetSeconds: 5 }; },
    // unknown reason token
    (body) => { body.autoplayOutcome = { ...body.autoplayOutcome, reason: 'timeout' }; },
  ]) {
    assert.throws(() => verifyWorkerResult(resignResult(mutate), golden.input));
  }
});

t('failure re-signing and secret-bearing fixed points are rejected', () => {
  for (const mutate of [
    (body) => { body.requestId = '10000000-0000-4000-8000-000000000099'; },
    (body) => { body.code = 'Not-Snake-Case'; },
    (body) => { body.message = 'ANTHROPIC_API_KEY=secret-value'; },
  ]) {
    assert.throws(() => verifyWorkerFailure(resignFailure(mutate), golden.input));
  }
});

t('feedback and canonical JSON retain exact frozen semantics', () => {
  const long = 'x'.repeat(FEEDBACK_MAX);
  assert.equal(validateExperimentFeedback(long), long);
  assert.throws(() => validateExperimentFeedback(` ${long.slice(1)}`), /printable/);
  assert.throws(() => validateExperimentFeedback('x'.repeat(FEEDBACK_MAX + 1)), /printable/);
  const forward = { b: 1, a: [{ z: true, y: null }], c: 'т' };
  const reordered = { c: 'т', a: [{ y: null, z: true }], b: 1 };
  assert.equal(canonicalJson(forward), canonicalJson(reordered));
});

t('worker source retains one provider invocation and no parallel CLI authority', () => {
  const source = readFileSync(path.join(here, '..', 'worker', 'experiment-rework.mjs'), 'utf8');
  assert.equal((source.match(/await invokeAgent\(/g) || []).length, 1);
  assert.ok(!source.includes('MAX_ATTEMPTS'));
  assert.ok(source.includes("new Set(['input-digest', 'input-envelope'])"));
  assert.ok(source.includes('loadWorkerInputEnvelope'));
  assert.ok(!/args\.(?:provider|model|feedback|parent|baseline|concept|prompt)/.test(source));
});

t('legacy experiment entrypoint remains byte-pinned to the live free-argument worker', () => {
  const legacy = readFileSync(path.join(here, '..', 'worker', 'experiment.mjs'));
  assert.equal(
    createHash('sha256').update(legacy).digest('hex'),
    'a2abed25926276944f49849618647d369f216e70f342e6949bb40d1064536716',
  );
  const source = legacy.toString('utf8');
  assert.ok(source.includes('const provider = args.provider'));
  assert.ok(source.includes('const feedback = String(args.feedback'));
  assert.ok(source.includes('MAX_ATTEMPTS'));
  assert.ok(!source.includes('loadWorkerInputEnvelope'));
});

t('typed publisher derives autoplay seed from the verified worker envelope', () => {
  const publisherSource = readFileSync(path.join(here, '..', 'worker', 'publish-experiment.mjs'), 'utf8');
  assert.ok(publisherSource.includes('testSeed = workerInput.worker.testSeed'));
});
