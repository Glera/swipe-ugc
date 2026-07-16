// Conformance tests for the exact experiment-worker contract.
//
// The frozen promises: feedback is never truncated (exact 1..2000), one job
// carries exactly one physical model invocation, a typed RESULT exists only
// for a proven autoplay win with complete evidence, and every RESULT carries
// parent binding, artifact identity and a deterministic self-digest.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FEEDBACK_MAX,
  WORKER_FAILURE_SCHEMA,
  WORKER_RESULT_SCHEMA,
  assertCompleteEvidence,
  buildWorkerFailure,
  buildWorkerResult,
  canonicalJson,
  digestOf,
  redactFailureMessage,
  validateExperimentFeedback,
  verifyWorkerFailure,
  verifyWorkerResult,
} from '../worker/result-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'experiment-worker-result-v1.golden.json'), 'utf8'),
);

function resultFields(overrides = {}) {
  return {
    id: 'gravity-wells-abc1234def-3f2c1a90-1111-4222-8333-abcdefabcdef',
    attemptUid: '3f2c1a90-1111-4222-8333-abcdefabcdef',
    parent: { experimentId: 'wild-sort-0123456789', patchSha256: 'b'.repeat(64) },
    baselineId: 'sort-v2',
    provider: 'claude',
    baseCommit: '1'.repeat(40),
    title: 'Gravity Wells',
    concept: {
      prompt: 'surprise me',
      feedback: 'make wells pull faster near the rim',
      pitch: 'marbles orbit moving wells',
      mechanic: 'wells drift and capture',
      feeling: 'orbital tension',
    },
    autoplayPassed: true,
    wallTimeMs: 123456,
    agentInvocations: 1,
    playtestRuns: 2,
    conformance: { idleMs: 30000, rafFrames: 1740 },
    autoplay: { durationMs: 42000, rafFrames: 2400, runNumber: 1, visualStates: 9 },
    model: 'sonnet',
    effort: 'medium',
    testSeed: 1592791604,
    files: ['marble-sort-swipe/src/main.ts'],
    agentSummary: 'added drifting gravity wells',
    createdAt: '2026-07-16T18:00:00.000Z',
    url: '/ugc/u/local-experiments/gravity-wells-abc1234def-3f2c1a90-1111-4222-8333-abcdefabcdef.html',
    coverUrl: '/ugc/u/local-experiments/gravity-wells-abc1234def-3f2c1a90-1111-4222-8333-abcdefabcdef.cover.png',
    coverBytes: 2048,
    artifact: {
      baseCommit: '1'.repeat(40),
      baselineId: 'sort-v2',
      htmlSha256: 'a'.repeat(64),
      coverSha256: 'c'.repeat(64),
      patchSha256: 'd'.repeat(64),
    },
    ...overrides,
  };
}

test('feedback is exact 1..2000 and never truncated', () => {
  const long = 'x'.repeat(FEEDBACK_MAX);
  assert.equal(validateExperimentFeedback(long), long);
  const midsize = 'у'.repeat(750);
  assert.equal(validateExperimentFeedback(midsize), midsize);
  assert.equal(validateExperimentFeedback(undefined), '');
  assert.throws(
    () => validateExperimentFeedback('x'.repeat(FEEDBACK_MAX + 1)),
    /1\.\.2000/,
  );
  assert.throws(() => validateExperimentFeedback(''.padEnd(0), { required: true }), /required/);
  assert.throws(() => validateExperimentFeedback(42), /string/);
});

test('canonical json is deterministic under key reordering', () => {
  const forward = { b: 1, a: [{ z: true, y: null }], c: 'т' };
  const reordered = { c: 'т', a: [{ y: null, z: true }], b: 1 };
  assert.equal(canonicalJson(forward), canonicalJson(reordered));
  assert.equal(digestOf(forward), digestOf(reordered));
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ bad: undefined }), /undefined/);
});

test('golden worker result digest replays byte-exactly', () => {
  const rebuilt = buildWorkerResult(GOLDEN.fields);
  assert.equal(rebuilt.schema, WORKER_RESULT_SCHEMA);
  assert.equal(rebuilt.resultDigest, GOLDEN.expectedResultDigest);
  assert.deepEqual(verifyWorkerResult(rebuilt), rebuilt);
  const tampered = { ...rebuilt, title: 'Renamed' };
  assert.throws(() => verifyWorkerResult(tampered), /digest/);
});

test('typed result exists only for one proven invocation', () => {
  const success = buildWorkerResult(resultFields());
  assert.equal(success.autoplayPassed, true);
  assert.equal(verifyWorkerResult(success).resultDigest, success.resultDigest);

  assert.throws(
    () => buildWorkerResult(resultFields({ autoplayPassed: false })),
    (error) => error.code === 'autoplay_unproven',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({ agentInvocations: 2 })),
    (error) => error.code === 'multiple_provider_invocations_share_one_job',
  );
  assert.throws(
    () => buildWorkerResult({ ...resultFields(), smuggled: true }),
    (error) => error.code === 'unknown_field',
  );
  const missing = resultFields();
  delete missing.artifact;
  assert.throws(() => buildWorkerResult(missing), (error) => error.code === 'missing_field');
  assert.throws(
    () => buildWorkerResult(resultFields({ artifact: { ...resultFields().artifact, htmlSha256: 'nope' } })),
    (error) => error.code === 'invalid_artifact',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({ parent: { experimentId: 'x', patchSha256: 'b'.repeat(64) } })),
    (error) => error.code === 'invalid_parent',
  );
  const fresh = buildWorkerResult(resultFields({
    parent: null,
    attemptUid: null,
    id: 'gravity-wells-abc1234def',
    url: '/ugc/u/local-experiments/gravity-wells-abc1234def.html',
    coverUrl: '/ugc/u/local-experiments/gravity-wells-abc1234def.cover.png',
  }));
  assert.equal(fresh.parent, null);
});

test('metrics are frozen exact evidence with real gate bounds', () => {
  assert.throws(
    () => buildWorkerResult(resultFields({ conformance: { fps: 60 } })),
    (error) => error.code === 'unknown_field' || error.code === 'missing_field',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({
      autoplay: { durationMs: 42000, rafFrames: 2400, runNumber: 3, visualStates: 9 },
    })),
    (error) => error.code === 'invalid_result',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({
      autoplay: { durationMs: 42000, rafFrames: 2400, runNumber: 1, visualStates: 1 },
    })),
    (error) => error.code === 'invalid_result',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({ files: ['marble-sort-swipe/assets/logo.png'] })),
    (error) => error.code === 'invalid_result',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({
      files: ['marble-sort-swipe/src/main.ts', 'marble-sort-swipe/src/main.ts'],
    })),
    (error) => error.code === 'invalid_result',
  );
});

test('a rework result requires the durable attempt uuid inside the id', () => {
  assert.throws(
    () => buildWorkerResult(resultFields({ attemptUid: null })),
    (error) => error.code === 'invalid_attempt_uid',
  );
  assert.throws(
    () => buildWorkerResult(resultFields({ attemptUid: 'ABC-not-canonical' })),
    (error) => error.code === 'invalid_attempt_uid',
  );
  const detachedId = resultFields({
    id: 'gravity-wells-abc1234def',
    url: '/ugc/u/local-experiments/gravity-wells-abc1234def.html',
    coverUrl: '/ugc/u/local-experiments/gravity-wells-abc1234def.cover.png',
  });
  assert.throws(
    () => buildWorkerResult(detachedId),
    (error) => error.code === 'invalid_result' && /untruncated/.test(error.message),
  );
});

test('a re-signed forged result fails full domain re-validation', () => {
  const honest = buildWorkerResult(resultFields());
  const resign = (mutate) => {
    const { resultDigest, ...body } = honest;
    const forged = mutate({ ...body });
    return { ...forged, resultDigest: digestOf(forged) };
  };
  // Valid digest over invalid claims: every forgery below carries a digest
  // that replays, so only full re-validation can reject it.
  assert.throws(
    () => verifyWorkerResult(resign((body) => ({ ...body, autoplayPassed: false }))),
    (error) => error.code === 'autoplay_unproven',
  );
  assert.throws(
    () => verifyWorkerResult(resign((body) => ({ ...body, agentInvocations: 3 }))),
    (error) => error.code === 'multiple_provider_invocations_share_one_job',
  );
  assert.throws(
    () => verifyWorkerResult(resign((body) => ({ ...body, smuggled: 'payload' }))),
    (error) => error.code === 'unknown_field',
  );
  assert.throws(
    () => verifyWorkerResult(resign((body) => ({ ...body, baseCommit: '9'.repeat(40) }))),
    (error) => error.code === 'invalid_result',
  );
  assert.throws(
    () => verifyWorkerResult(resign((body) => ({ ...body, url: '/elsewhere.html' }))),
    (error) => error.code === 'invalid_result',
  );
  assert.throws(
    () => verifyWorkerResult(
      resign((body) => ({ ...body, conformance: 'trust me' })),
    ),
    (error) => error.code === 'invalid_result',
  );
  // A tuning pass whose patch digest equals its parent is a forged no-op.
  assert.throws(
    () => verifyWorkerResult(
      resign((body) => ({
        ...body,
        parent: { experimentId: body.parent.experimentId, patchSha256: body.artifact.patchSha256 },
      })),
    ),
    (error) => error.code === 'invalid_result',
  );
});

test('incomplete evidence is a typed refusal that names what is missing', () => {
  const complete = {
    validated: { patch: 'diff --git a b' },
    artifactHtml: '<html/>',
    coverPng: Buffer.from([1, 2, 3]),
    autoplayPassed: true,
    conformanceMetrics: { fps: 60 },
    autoplayMetrics: { outcome: 'won' },
  };
  assert.doesNotThrow(() => assertCompleteEvidence(complete));
  for (const [field, breaker, expected] of [
    ['autoplayPassed', false, 'autoplay_win'],
    ['coverPng', null, 'cover_png'],
    ['conformanceMetrics', null, 'conformance_metrics'],
    ['autoplayMetrics', null, 'autoplay_metrics'],
    ['artifactHtml', '', 'artifact_html'],
  ]) {
    assert.throws(
      () => assertCompleteEvidence({ ...complete, [field]: breaker }),
      (error) => error.code === 'incomplete_evidence' && error.message.includes(expected),
    );
  }
});

test('worker failures are typed, redacted, digest-bound and exactly verifiable', () => {
  const failure = buildWorkerFailure({
    code: 'autoplay_unproven',
    message: `boom\u001b[31m at ${process.env.HOME || '/home/x'}/secret/path\n  at stack`,
    provider: 'claude',
    model: 'sonnet',
  });
  assert.equal(failure.schema, WORKER_FAILURE_SCHEMA);
  assert.equal(failure.code, 'autoplay_unproven');
  assert.ok(!failure.message.includes(process.env.HOME || '/home/x'), 'home path must be redacted');
  assert.ok(!/[\u0000-\u001f]/.test(failure.message), 'control chars must be redacted');
  assert.deepEqual(verifyWorkerFailure(failure), failure);

  // Exact verifier refuses forged codes, unredacted text and smuggled keys.
  const { failureDigest, ...body } = failure;
  const resign = (mutate) => {
    const forged = mutate({ ...body });
    return { ...forged, failureDigest: digestOf(forged) };
  };
  assert.throws(
    () => verifyWorkerFailure(resign((b) => ({ ...b, code: 'Not A Code!' }))),
    (error) => error.code === 'invalid_failure',
  );
  assert.throws(
    () => verifyWorkerFailure(resign((b) => ({ ...b, message: 'x'.repeat(2001) }))),
    (error) => error.code === 'invalid_failure',
  );
  assert.throws(
    () => verifyWorkerFailure(resign((b) => ({ ...b, smuggled: true }))),
    (error) => error.code === 'unknown_field',
  );
  assert.throws(
    () => verifyWorkerFailure({ ...failure, message: 'tampered' }),
    (error) => error.code === 'failure_digest_mismatch',
  );
  assert.equal(redactFailureMessage('a\u0000b   c'), 'a b c');
});

test('experiment worker source keeps the exact contract', () => {
  const source = readFileSync(path.join(here, '..', 'worker', 'experiment.mjs'), 'utf8');
  assert.ok(!/feedback\s*=[^\n]*slice\(/.test(source), 'feedback must not be truncated');
  assert.ok(!/MAX_ATTEMPTS/.test(source), 'the internal repair loop must stay removed');
  const invocations = source.match(/await invokeAgent\(/g) || [];
  assert.equal(invocations.length, 1, 'one job carries exactly one model invocation');
  assert.ok(source.includes('publishExperimentResult'), 'RESULT must go through the typed publication module');
  assert.ok(source.includes('assertCompleteEvidence'), 'success requires complete evidence');
  assert.ok(!/soft-gate/.test(source), 'the unproven-win soft success must stay removed');
});
