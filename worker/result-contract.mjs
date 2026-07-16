// Independent worker-side mirror of the frozen experiment worker wire.
// The canonical source is the generator-owned cross-repo golden fixture;
// tests read that file directly, so this implementation cannot drift behind
// a copied fixture inside swipe-ugc.
import { createHash } from 'node:crypto';

export const EXPERIMENT_WORKER_INPUT_SCHEMA = 'lab.experiment-worker-input.v1';
export const WORKER_RESULT_SCHEMA = 'ugc.experiment-worker-result.v1';
export const WORKER_FAILURE_SCHEMA = 'ugc.experiment-worker-failure.v1';
export const FEEDBACK_MIN = 1;
export const FEEDBACK_MAX = 2000;
export const FEEDBACK_MAX_BYTES = 8000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TARGET = /^[a-z0-9-]{8,80}$/;
const PROFILE = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const GIT_OBJECT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BARE_DIGEST = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SOURCE = /^marble-sort-swipe\/src\/[A-Za-z0-9_./-]+\.ts$/;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const INPUT_KEYS = ['attempt', 'baseline', 'inputDigest', 'model', 'parent', 'request', 'schema', 'worker'];
const REQUEST_KEYS = ['id', 'instruction', 'requestHash', 'requestedEffort', 'requestedModelProfileId'];
const ATTEMPT_KEYS = ['id', 'jobId', 'modelExecutionReceiptId', 'ordinal'];
const MODEL_KEYS = ['argument', 'effort', 'profileDigest', 'profileId', 'provider'];
const PARENT_KEYS = ['evidence', 'reviewId', 'targetId'];
const BASELINE_KEYS = ['id', 'sourceCommit', 'sourceTree'];
const WORKER_KEYS = ['contractDigest', 'gateVersion', 'testSeed'];
const EVIDENCE_KEYS = ['parentArtifact', 'parentArtifactDigest', 'parentReviewDigest', 'schema'];
const PARENT_ARTIFACT_KEYS = [
  'baseCommit', 'baselineId', 'baselineTree', 'coverSha256', 'experimentId',
  'htmlSha256', 'manifestSha256', 'patchSha256', 'schema',
];
const RESULT_KEYS = [
  'agentInvocations', 'agentSummary', 'artifact', 'attemptUid', 'autoplay',
  'autoplayPassed', 'baseCommit', 'baselineId', 'baselineTree', 'concept',
  'conformance', 'coverBytes', 'coverUrl', 'createdAt', 'effort', 'files',
  'gateVersion', 'id', 'inputDigest', 'jobId', 'model',
  'modelExecutionReceiptId', 'parent', 'playtestRuns', 'provider', 'requestId',
  'resultDigest', 'schema', 'testSeed', 'title', 'url', 'wallTimeMs',
  'workerContractDigest',
];
const RESULT_PARENT_KEYS = ['experimentId', 'parentArtifactDigest', 'parentReviewDigest'];
const ARTIFACT_KEYS = ['baseCommit', 'baselineId', 'baselineTree', 'coverSha256', 'htmlSha256', 'patchSha256'];
const CONCEPT_KEYS = ['feedback', 'feeling', 'mechanic', 'pitch', 'prompt'];
const CONFORMANCE_KEYS = ['idleMs', 'rafFrames'];
const AUTOPLAY_KEYS = ['durationMs', 'rafFrames', 'runNumber', 'visualStates'];
const FAILURE_KEYS = [
  'attemptUid', 'code', 'failureDigest', 'inputDigest', 'jobId', 'message',
  'model', 'modelExecutionReceiptId', 'provider', 'requestId', 'schema',
];
const RUNTIME_RESULT_KEYS = [
  'agentInvocations', 'agentSummary', 'artifact', 'autoplay', 'autoplayPassed',
  'concept', 'conformance', 'coverBytes', 'createdAt', 'files', 'playtestRuns',
  'title', 'wallTimeMs',
];

export function contractError(code, message) {
  const error = new Error(String(message).replace(/\s+/g, ' ').trim().slice(0, 2000));
  error.code = code;
  return error;
}

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw contractError('non_finite_number', 'canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw contractError('unsupported_value', 'canonical JSON can contain JSON values only');
}

export function sha256Hex(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

export function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw contractError('experiment_worker_contract_invalid', `${label} has invalid exact keys`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

// The public definition is an immutable value snapshot, never an alias to the
// verifier's private key tables. Consumers may safely retain it as evidence
// without acquiring authority over validation behaviour.
export const EXPERIMENT_WORKER_CONTRACT_DEFINITION = deepFreeze({
  schema: 'lab.experiment-worker-contract.v1',
  inputSchema: EXPERIMENT_WORKER_INPUT_SCHEMA,
  resultSchema: WORKER_RESULT_SCHEMA,
  failureSchema: WORKER_FAILURE_SCHEMA,
  canonicalization: 'RFC8785-compatible-json.v1',
  terminalJson: 'compact-JSON.stringify-no-duplicate-keys',
  manifestJson: 'JSON.stringify-2space-newline-no-duplicate-keys',
  digestFormat: 'sha256:<lowercase-hex>',
  candidateId: 'rework-<canonical-attempt-uuid>-<patch-sha256-first-12-hex>',
  keys: {
    input: [...INPUT_KEYS],
    request: [...REQUEST_KEYS],
    attempt: [...ATTEMPT_KEYS],
    model: [...MODEL_KEYS],
    parent: [...PARENT_KEYS],
    baseline: [...BASELINE_KEYS],
    worker: [...WORKER_KEYS],
    parentEvidence: [...EVIDENCE_KEYS],
    result: [...RESULT_KEYS],
    resultParent: [...RESULT_PARENT_KEYS],
    artifact: [...ARTIFACT_KEYS],
    concept: [...CONCEPT_KEYS],
    conformance: [...CONFORMANCE_KEYS],
    autoplay: [...AUTOPLAY_KEYS],
    failure: [...FAILURE_KEYS],
  },
  bounds: {
    instructionChars: [1, 2000],
    instructionUtf8Bytes: 8000,
    attemptOrdinal: [1, 10_000],
    playtestRuns: [1, 2],
    autoplayRunNumber: [1, 2],
    autoplayVisualStatesMin: 2,
    testSeed: [0, 0xffff_ffff],
    files: [1, 200],
  },
  sourceFilePattern: SOURCE.source,
  filesCanonicalOrder: 'unique-lexicographic-ascending',
  redactionVersion: 'model-evidence-sanitizer.v2',
  redactedFields: ['agentSummary', 'failure.message'],
  testSeedBinding: 'input.worker.testSeed=result.testSeed',
  evidenceRelations: ['playtestRuns=autoplay.runNumber'],
});

export const EXPERIMENT_WORKER_CONTRACT_DIGEST = digestOf(
  EXPERIMENT_WORKER_CONTRACT_DEFINITION,
);

function printable(value, label, { min = 1, max = 2000, maxBytes = 8000 } = {}) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min || value.length > max
    || Buffer.byteLength(value, 'utf8') > maxBytes || CONTROL.test(value)) {
    throw contractError('experiment_worker_contract_invalid', `${label} is outside the printable contract`);
  }
  return value;
}

function count(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw contractError('experiment_worker_contract_invalid', `${label} is outside its integer bounds`);
  }
  return value;
}

export function validateExperimentFeedback(value, { required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return '';
  return printable(value, 'request instruction', {
    min: FEEDBACK_MIN,
    max: FEEDBACK_MAX,
    maxBytes: FEEDBACK_MAX_BYTES,
  });
}

function normaliseParentArtifact(raw) {
  const value = structuredClone(raw);
  exactKeys(value, PARENT_ARTIFACT_KEYS, 'parent artifact');
  if (value.schema !== 'lab.experiment-artifact-identity.v1'
    || !TARGET.test(String(value.experimentId || ''))
    || !PROFILE.test(String(value.baselineId || ''))
    || !GIT_OBJECT.test(String(value.baseCommit || ''))
    || !GIT_OBJECT.test(String(value.baselineTree || ''))
    || ['manifestSha256', 'patchSha256', 'htmlSha256', 'coverSha256']
      .some((key) => !DIGEST.test(String(value[key] || '')))) {
    throw contractError('experiment_worker_contract_invalid', 'parent artifact identity is invalid');
  }
  return value;
}

function normaliseInputBody(raw) {
  const value = structuredClone(raw);
  exactKeys(value, INPUT_KEYS.filter((key) => key !== 'inputDigest'), 'worker input body');
  if (value.schema !== EXPERIMENT_WORKER_INPUT_SCHEMA) {
    throw contractError('experiment_worker_contract_invalid', 'worker input schema is invalid');
  }
  exactKeys(value.request, REQUEST_KEYS, 'worker input request');
  exactKeys(value.attempt, ATTEMPT_KEYS, 'worker input attempt');
  exactKeys(value.model, MODEL_KEYS, 'worker input model');
  exactKeys(value.parent, PARENT_KEYS, 'worker input parent');
  exactKeys(value.baseline, BASELINE_KEYS, 'worker input baseline');
  exactKeys(value.worker, WORKER_KEYS, 'worker input contract');
  if (!UUID.test(String(value.request.id || '')) || !DIGEST.test(String(value.request.requestHash || ''))
    || !PROFILE.test(String(value.request.requestedModelProfileId || ''))
    || !EFFORT.test(String(value.request.requestedEffort || ''))) {
    throw contractError('experiment_worker_contract_invalid', 'worker request identity is invalid');
  }
  value.request.instruction = validateExperimentFeedback(value.request.instruction);
  if (!UUID.test(String(value.attempt.id || '')) || !UUID.test(String(value.attempt.jobId || ''))
    || !UUID.test(String(value.attempt.modelExecutionReceiptId || ''))) {
    throw contractError('experiment_worker_contract_invalid', 'worker attempt identity is invalid');
  }
  value.attempt.ordinal = count(value.attempt.ordinal, 'attempt ordinal', { min: 1, max: 10_000 });
  if (!['codex', 'claude'].includes(value.model.provider)
    || !PROFILE.test(String(value.model.profileId || ''))
    || !printable(value.model.argument, 'model argument', { max: 80, maxBytes: 320 })
    || !EFFORT.test(String(value.model.effort || ''))
    || !BARE_DIGEST.test(String(value.model.profileDigest || ''))
    || value.model.profileId !== value.request.requestedModelProfileId
    || value.model.effort !== value.request.requestedEffort) {
    throw contractError('experiment_worker_contract_invalid', 'worker model selection differs from request');
  }
  const evidence = structuredClone(value.parent.evidence);
  exactKeys(evidence, EVIDENCE_KEYS, 'parent evidence');
  evidence.parentArtifact = normaliseParentArtifact(evidence.parentArtifact);
  if (evidence.schema !== 'lab.experiment-rework-parent.v1'
    || !DIGEST.test(String(evidence.parentReviewDigest || ''))
    || !DIGEST.test(String(evidence.parentArtifactDigest || ''))
    || evidence.parentArtifactDigest !== digestOf(evidence.parentArtifact)) {
    throw contractError('experiment_worker_contract_invalid', 'parent evidence identity is invalid');
  }
  value.parent.evidence = evidence;
  if (!UUID.test(String(value.parent.reviewId || '')) || !TARGET.test(String(value.parent.targetId || ''))
    || value.parent.targetId !== evidence.parentArtifact.experimentId) {
    throw contractError('experiment_worker_contract_invalid', 'worker parent binding is invalid');
  }
  if (!PROFILE.test(String(value.baseline.id || ''))
    || !GIT_OBJECT.test(String(value.baseline.sourceCommit || ''))
    || !GIT_OBJECT.test(String(value.baseline.sourceTree || ''))
    || value.baseline.id !== evidence.parentArtifact.baselineId
    || value.baseline.sourceCommit !== evidence.parentArtifact.baseCommit
    || value.baseline.sourceTree !== evidence.parentArtifact.baselineTree) {
    throw contractError('experiment_worker_contract_invalid', 'worker baseline differs from parent evidence');
  }
  if (value.worker.contractDigest !== EXPERIMENT_WORKER_CONTRACT_DIGEST
    || !DIGEST.test(String(value.worker.gateVersion || ''))) {
    throw contractError('experiment_worker_contract_invalid', 'worker contract or gate version is invalid');
  }
  value.worker.testSeed = count(value.worker.testSeed, 'worker testSeed', { max: 0xffff_ffff });
  return value;
}

export function verifyWorkerInput(raw) {
  const value = structuredClone(raw);
  exactKeys(value, INPUT_KEYS, 'worker input document');
  const { inputDigest, ...body } = value;
  const normalised = normaliseInputBody(body);
  if (!DIGEST.test(String(inputDigest || '')) || inputDigest !== digestOf(normalised)) {
    throw contractError('experiment_worker_input_digest_mismatch', 'worker input digest does not replay');
  }
  return Object.freeze({ ...normalised, inputDigest });
}

export function experimentCandidateId(input, patchSha256) {
  const verified = verifyWorkerInput(input);
  if (!DIGEST.test(String(patchSha256 || ''))) {
    throw contractError('experiment_worker_contract_invalid', 'candidate patch digest is invalid');
  }
  return `rework-${verified.attempt.id}-${patchSha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

function validateMetrics(value, keys, label) {
  exactKeys(value, keys, label);
  if (label === 'conformance') {
    count(value.idleMs, 'conformance.idleMs');
    count(value.rafFrames, 'conformance.rafFrames', { min: 1 });
  } else {
    count(value.durationMs, 'autoplay.durationMs', { min: 1 });
    count(value.rafFrames, 'autoplay.rafFrames', { min: 1 });
    count(value.runNumber, 'autoplay.runNumber', { min: 1, max: 2 });
    count(value.visualStates, 'autoplay.visualStates', { min: 2 });
  }
}

function verifyBoundIdentity(value, input) {
  if (value.inputDigest !== input.inputDigest || value.requestId !== input.request.id
    || value.attemptUid !== input.attempt.id || value.jobId !== input.attempt.jobId
    || value.modelExecutionReceiptId !== input.attempt.modelExecutionReceiptId
    || value.provider !== input.model.provider || value.model !== input.model.argument) {
    throw contractError('experiment_worker_binding_mismatch', 'worker output differs from immutable input');
  }
}

export function verifyWorkerResult(raw, expectedInput) {
  const input = verifyWorkerInput(expectedInput);
  const value = structuredClone(raw);
  exactKeys(value, RESULT_KEYS, 'worker RESULT');
  if (value.schema !== WORKER_RESULT_SCHEMA || !DIGEST.test(String(value.resultDigest || ''))) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT identity is invalid');
  }
  const { resultDigest, ...body } = value;
  if (resultDigest !== digestOf(body)) {
    throw contractError('experiment_worker_result_digest_mismatch', 'worker RESULT digest does not replay');
  }
  verifyBoundIdentity(body, input);
  if (body.autoplayPassed !== true || body.agentInvocations !== 1
    || body.effort !== input.model.effort || body.workerContractDigest !== input.worker.contractDigest
    || body.gateVersion !== input.worker.gateVersion || body.testSeed !== input.worker.testSeed
    || body.baseCommit !== input.baseline.sourceCommit || body.baselineId !== input.baseline.id
    || body.baselineTree !== input.baseline.sourceTree) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT contradicts proven execution');
  }
  exactKeys(body.parent, RESULT_PARENT_KEYS, 'worker RESULT parent');
  if (body.parent.experimentId !== input.parent.targetId
    || body.parent.parentArtifactDigest !== input.parent.evidence.parentArtifactDigest
    || body.parent.parentReviewDigest !== input.parent.evidence.parentReviewDigest) {
    throw contractError('experiment_worker_binding_mismatch', 'worker RESULT parent differs from input evidence');
  }
  exactKeys(body.artifact, ARTIFACT_KEYS, 'worker RESULT artifact');
  if (body.artifact.baseCommit !== input.baseline.sourceCommit
    || body.artifact.baselineId !== input.baseline.id
    || body.artifact.baselineTree !== input.baseline.sourceTree
    || !DIGEST.test(String(body.artifact.htmlSha256 || ''))
    || !DIGEST.test(String(body.artifact.coverSha256 || ''))
    || !DIGEST.test(String(body.artifact.patchSha256 || ''))
    || body.artifact.patchSha256 === input.parent.evidence.parentArtifact.patchSha256) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT artifact identity is invalid');
  }
  if (body.id !== experimentCandidateId(input, body.artifact.patchSha256)
    || body.url !== `/ugc/u/local-experiments/${body.id}.html`
    || body.coverUrl !== `/ugc/u/local-experiments/${body.id}.cover.png`) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT candidate projection is invalid');
  }
  exactKeys(body.concept, CONCEPT_KEYS, 'worker RESULT concept');
  if (body.concept.feedback !== input.request.instruction) {
    throw contractError('experiment_worker_binding_mismatch', 'worker RESULT feedback differs from input');
  }
  for (const [key, max] of [['prompt', 500], ['pitch', 500], ['mechanic', 500], ['feeling', 240]]) {
    printable(body.concept[key], `concept.${key}`, { min: 0, max, maxBytes: max * 4 });
  }
  validateMetrics(body.conformance, CONFORMANCE_KEYS, 'conformance');
  validateMetrics(body.autoplay, AUTOPLAY_KEYS, 'autoplay');
  count(body.wallTimeMs, 'wallTimeMs');
  count(body.playtestRuns, 'playtestRuns', { min: 1, max: 2 });
  if (body.playtestRuns !== body.autoplay.runNumber) {
    throw contractError('experiment_worker_result_invalid', 'playtestRuns differs from autoplay.runNumber');
  }
  count(body.coverBytes, 'coverBytes', { min: 1 });
  printable(body.title, 'title', { max: 60, maxBytes: 240 });
  printable(body.agentSummary, 'agentSummary', { min: 0, max: 5000, maxBytes: 20_000 });
  if (body.agentSummary !== sanitiseModelEvidence(body.agentSummary, 5000)) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT summary is not redacted');
  }
  if (!ISO_MILLIS.test(String(body.createdAt || '')) || Number.isNaN(Date.parse(body.createdAt))) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT createdAt is invalid');
  }
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 200
    || JSON.stringify(body.files) !== JSON.stringify([...new Set(body.files)].sort())
    || body.files.some((file) => typeof file !== 'string' || !SOURCE.test(file) || file.includes('..'))) {
    throw contractError('experiment_worker_result_invalid', 'worker RESULT files are unsafe or non-canonical');
  }
  return Object.freeze(value);
}

export function buildWorkerResult(runtimeFields, expectedInput) {
  const input = verifyWorkerInput(expectedInput);
  const runtime = structuredClone(runtimeFields);
  exactKeys(runtime, RUNTIME_RESULT_KEYS, 'worker runtime RESULT');
  const artifact = structuredClone(runtime.artifact);
  const id = experimentCandidateId(input, artifact.patchSha256);
  const body = {
    schema: WORKER_RESULT_SCHEMA,
    inputDigest: input.inputDigest,
    requestId: input.request.id,
    attemptUid: input.attempt.id,
    jobId: input.attempt.jobId,
    modelExecutionReceiptId: input.attempt.modelExecutionReceiptId,
    id,
    parent: {
      experimentId: input.parent.targetId,
      parentArtifactDigest: input.parent.evidence.parentArtifactDigest,
      parentReviewDigest: input.parent.evidence.parentReviewDigest,
    },
    baselineId: input.baseline.id,
    provider: input.model.provider,
    baseCommit: input.baseline.sourceCommit,
    baselineTree: input.baseline.sourceTree,
    title: runtime.title,
    concept: { ...runtime.concept, feedback: input.request.instruction },
    autoplayPassed: runtime.autoplayPassed,
    wallTimeMs: runtime.wallTimeMs,
    agentInvocations: runtime.agentInvocations,
    playtestRuns: runtime.playtestRuns,
    conformance: runtime.conformance,
    autoplay: runtime.autoplay,
    gateVersion: input.worker.gateVersion,
    workerContractDigest: input.worker.contractDigest,
    model: input.model.argument,
    effort: input.model.effort,
    testSeed: input.worker.testSeed,
    files: runtime.files,
    agentSummary: sanitiseModelEvidence(runtime.agentSummary, 5000),
    createdAt: runtime.createdAt,
    url: `/ugc/u/local-experiments/${id}.html`,
    coverUrl: `/ugc/u/local-experiments/${id}.cover.png`,
    coverBytes: runtime.coverBytes,
    artifact,
  };
  const result = { ...body, resultDigest: digestOf(body) };
  return verifyWorkerResult(result, input);
}

const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|AUTH|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*([^\s,;]+)/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g;
const TELEGRAM_HASH = /([?&]|\b)(hash|query_id|initData)=([^\s&]+)/gi;

export function sanitiseModelEvidence(value, limit = 2000) {
  const redact = (input) => String(input || '')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(JWT, '[REDACTED_JWT]')
    .replace(TELEGRAM_HASH, '$1$2=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  const first = redact(value);
  const boundedTail = first.length > limit ? first.slice(-limit) : first;
  return redact(boundedTail).slice(0, limit);
}

export function verifyWorkerFailure(raw, expectedInput) {
  const input = verifyWorkerInput(expectedInput);
  const value = structuredClone(raw);
  exactKeys(value, FAILURE_KEYS, 'worker ERROR');
  if (value.schema !== WORKER_FAILURE_SCHEMA || !DIGEST.test(String(value.failureDigest || ''))) {
    throw contractError('experiment_worker_failure_invalid', 'worker ERROR identity is invalid');
  }
  const { failureDigest, ...body } = value;
  if (failureDigest !== digestOf(body)) {
    throw contractError('experiment_worker_failure_digest_mismatch', 'worker ERROR digest does not replay');
  }
  verifyBoundIdentity(body, input);
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(String(body.code || ''))
    || body.message !== sanitiseModelEvidence(body.message, 2000)) {
    throw contractError('experiment_worker_failure_invalid', 'worker ERROR is unbounded or not redacted');
  }
  return Object.freeze(value);
}

export function buildWorkerFailure({ input: expectedInput, code, message }) {
  const input = verifyWorkerInput(expectedInput);
  const safeCode = /^[a-z][a-z0-9_]{0,99}$/.test(String(code || '')) ? String(code) : 'worker_failed';
  const body = {
    schema: WORKER_FAILURE_SCHEMA,
    inputDigest: input.inputDigest,
    requestId: input.request.id,
    attemptUid: input.attempt.id,
    jobId: input.attempt.jobId,
    modelExecutionReceiptId: input.attempt.modelExecutionReceiptId,
    code: safeCode,
    message: sanitiseModelEvidence(message, 2000),
    provider: input.model.provider,
    model: input.model.argument,
  };
  const failure = { ...body, failureDigest: digestOf(body) };
  return verifyWorkerFailure(failure, input);
}

export function assertCompleteEvidence({
  validated,
  artifactHtml,
  coverPng,
  autoplayPassed,
  conformanceMetrics,
  autoplayMetrics,
}) {
  const missing = [];
  if (!validated || typeof validated.patch !== 'string' || !validated.patch) missing.push('patch');
  if (typeof artifactHtml !== 'string' || !artifactHtml) missing.push('artifact_html');
  if (!coverPng || !coverPng.length) missing.push('cover_png');
  if (!conformanceMetrics) missing.push('conformance_metrics');
  if (!autoplayMetrics) missing.push('autoplay_metrics');
  if (autoplayPassed !== true) missing.push('autoplay_win');
  if (missing.length) {
    throw contractError('incomplete_evidence', `worker success requires complete evidence; missing: ${missing.join(', ')}`);
  }
}
