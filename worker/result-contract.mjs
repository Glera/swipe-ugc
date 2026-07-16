// Exact experiment-worker result contract (conformance slice, fix round 2).
//
// One physical model invocation = one job = one worker process = at most one
// typed RESULT. The worker never publishes success without a proven autoplay
// win and complete evidence; every success carries parent binding, artifact
// identity and a deterministic self-digest. `verifyWorkerResult` re-validates
// the COMPLETE domain, so a re-signed forged document (valid digest over
// invalid claims) is rejected exactly like a tampered one.
import { createHash } from 'crypto';

export const WORKER_RESULT_SCHEMA = 'ugc.experiment-worker-result.v1';
export const WORKER_FAILURE_SCHEMA = 'ugc.experiment-worker-failure.v1';
export const FEEDBACK_MIN = 1;
export const FEEDBACK_MAX = 2000;
export const FEEDBACK_MAX_BYTES = 8000;

const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const EXPERIMENT_ID = /^[a-z0-9-]{8,80}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE_FILE = /^marble-sort-swipe\/src\/[A-Za-z0-9._/-]+\.ts$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function canonicalJson(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw contractError('non_finite_number', 'result numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (kind === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        if (value[key] === undefined) throw contractError('undefined_field', `field ${key} is undefined`);
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
      })
      .join(',')}}`;
  }
  throw contractError('unsupported_value', `cannot canonicalize a ${kind}`);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

export function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('invalid_shape', `${label} must be an object`);
  }
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw contractError('unknown_field', `${label} contains unknown field ${extra[0]}`);
  const missing = allowed.filter((key) => value[key] === undefined);
  if (missing.length) throw contractError('missing_field', `${label} is missing ${missing[0]}`);
  return value;
}

// Feedback mirrors the generator's rework-instruction domain exactly:
// printable (no control characters), no leading/trailing whitespace,
// 1..2000 characters and at most 8000 utf-8 bytes. The worker never trims,
// truncates or otherwise rewrites it.
export function validateExperimentFeedback(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw contractError('invalid_feedback', 'feedback is required for a tuning pass');
    return '';
  }
  if (typeof raw !== 'string') throw contractError('invalid_feedback', 'feedback must be a string');
  if (raw.length < FEEDBACK_MIN || raw.length > FEEDBACK_MAX) {
    throw contractError(
      'invalid_feedback',
      `feedback must contain ${FEEDBACK_MIN}..${FEEDBACK_MAX} characters, got ${raw.length}`,
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > FEEDBACK_MAX_BYTES) {
    throw contractError('invalid_feedback', `feedback must fit ${FEEDBACK_MAX_BYTES} utf-8 bytes`);
  }
  if (CONTROL_CHARS.test(raw)) {
    throw contractError('invalid_feedback', 'feedback cannot contain control characters');
  }
  if (raw !== raw.trim()) {
    throw contractError('invalid_feedback', 'feedback cannot carry leading or trailing whitespace');
  }
  return raw;
}

const PARENT_KEYS = ['experimentId', 'patchSha256'];
const ARTIFACT_KEYS = ['baseCommit', 'baselineId', 'coverSha256', 'htmlSha256', 'patchSha256'];
const CONCEPT_KEYS = ['feedback', 'feeling', 'mechanic', 'pitch', 'prompt'];

export function buildParentBinding(parent) {
  if (parent === null) return null;
  exactKeys(parent, PARENT_KEYS, 'parent binding');
  if (!EXPERIMENT_ID.test(String(parent.experimentId))) {
    throw contractError('invalid_parent', 'parent experimentId is invalid');
  }
  if (!HEX64.test(String(parent.patchSha256))) {
    throw contractError('invalid_parent', 'parent patchSha256 must be a 64-hex sha256');
  }
  return { experimentId: parent.experimentId, patchSha256: parent.patchSha256 };
}

export function buildArtifactIdentity(artifact) {
  exactKeys(artifact, ARTIFACT_KEYS, 'artifact identity');
  for (const key of ['coverSha256', 'htmlSha256', 'patchSha256']) {
    if (!HEX64.test(String(artifact[key]))) {
      throw contractError('invalid_artifact', `${key} must be a 64-hex sha256`);
    }
  }
  if (!HEX40.test(String(artifact.baseCommit))) {
    throw contractError('invalid_artifact', 'baseCommit must be a 40-hex git commit');
  }
  if (!String(artifact.baselineId || '').trim()) {
    throw contractError('invalid_artifact', 'baselineId is required');
  }
  return {
    baseCommit: artifact.baseCommit,
    baselineId: artifact.baselineId,
    coverSha256: artifact.coverSha256,
    htmlSha256: artifact.htmlSha256,
    patchSha256: artifact.patchSha256,
  };
}

// Success requires complete evidence: a proven autoplay win, conformance and
// autoplay metrics, the artifact bytes and the cover. Anything missing is a
// typed refusal, never a soft success.
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
    throw contractError(
      'incomplete_evidence',
      `worker success requires complete evidence; missing: ${missing.join(', ')}`,
    );
  }
}

const RESULT_FIELD_KEYS = [
  'agentInvocations',
  'agentSummary',
  'artifact',
  'attemptUid',
  'autoplay',
  'autoplayPassed',
  'baseCommit',
  'baselineId',
  'concept',
  'conformance',
  'coverBytes',
  'coverUrl',
  'createdAt',
  'effort',
  'files',
  'id',
  'model',
  'parent',
  'playtestRuns',
  'provider',
  'testSeed',
  'title',
  'url',
  'wallTimeMs',
];

function requireBoundedString(value, label, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw contractError('invalid_result', `${label} must be a ${min}..${max} character string`);
  }
  return value;
}

function requireCount(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw contractError('invalid_result', `${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('invalid_result', `${label} must be a plain object`);
  }
  return value;
}

// Metrics are frozen exact evidence, not free-form diagnostics: the fields
// below are exactly what the conformance and autoplay gates measure, with
// bounds that a real browser run can actually produce.
export function validateConformanceMetrics(value) {
  exactKeys(value, ['idleMs', 'rafFrames'], 'conformance metrics');
  requireCount(value.idleMs, 'conformance.idleMs', { min: 1, max: 600000 });
  requireCount(value.rafFrames, 'conformance.rafFrames', { min: 0, max: 10_000_000 });
  return value;
}

export function validateAutoplayMetrics(value) {
  exactKeys(value, ['durationMs', 'rafFrames', 'runNumber', 'visualStates'], 'autoplay metrics');
  requireCount(value.durationMs, 'autoplay.durationMs', { min: 1, max: 86_400_000 });
  requireCount(value.rafFrames, 'autoplay.rafFrames', { min: 1, max: 10_000_000 });
  // The gate itself requires at least two distinct canvas states for a win.
  requireCount(value.visualStates, 'autoplay.visualStates', { min: 2, max: 1_000_000 });
  if (![1, 2].includes(value.runNumber)) {
    throw contractError('invalid_result', 'autoplay.runNumber must be 1 or 2 (single flake retry)');
  }
  return value;
}

export function validateAttemptUid(value, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) {
      throw contractError('invalid_attempt_uid', 'a rework run requires the durable attempt UUID');
    }
    return null;
  }
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    throw contractError('invalid_attempt_uid', 'attemptUid must be a canonical lowercase UUID');
  }
  return value;
}

function validateWorkerResultFields(fields) {
  exactKeys(fields, RESULT_FIELD_KEYS, 'worker result');
  if (fields.autoplayPassed !== true) {
    throw contractError('autoplay_unproven', 'a typed worker RESULT exists only for a proven autoplay win');
  }
  if (fields.agentInvocations !== 1) {
    throw contractError(
      'multiple_provider_invocations_share_one_job',
      'one job carries exactly one physical model invocation',
    );
  }
  if (!EXPERIMENT_ID.test(String(fields.id))) {
    throw contractError('invalid_result', 'experiment id is invalid');
  }
  validateAttemptUid(fields.attemptUid, { required: fields.parent !== null });
  if (fields.attemptUid !== null && !String(fields.id).endsWith(`-${fields.attemptUid}`)) {
    throw contractError('invalid_result', 'candidate id must embed the full untruncated attempt UUID');
  }
  if (!['codex', 'claude'].includes(fields.provider)) {
    throw contractError('invalid_result', 'provider must be codex or claude');
  }
  requireBoundedString(fields.model, 'model', { min: 1, max: 80 });
  requireBoundedString(fields.effort, 'effort', { min: 1, max: 32 });
  requireBoundedString(fields.title, 'title', { min: 1, max: 60 });
  requireBoundedString(fields.agentSummary, 'agentSummary', { min: 0, max: 5000 });
  requireCount(fields.wallTimeMs, 'wallTimeMs', { min: 0 });
  requireCount(fields.playtestRuns, 'playtestRuns', { min: 1, max: 1000 });
  requireCount(fields.coverBytes, 'coverBytes', { min: 1 });
  requireCount(fields.testSeed, 'testSeed', { min: 0, max: 0xffffffff });
  if (!ISO_MILLIS.test(String(fields.createdAt)) || Number.isNaN(Date.parse(fields.createdAt))) {
    throw contractError('invalid_result', 'createdAt must be an exact millisecond ISO timestamp');
  }
  const concept = requirePlainObject(fields.concept, 'concept');
  exactKeys(concept, CONCEPT_KEYS, 'concept');
  requireBoundedString(concept.prompt, 'concept.prompt', { min: 0, max: 500 });
  requireBoundedString(concept.pitch, 'concept.pitch', { min: 0, max: 500 });
  requireBoundedString(concept.mechanic, 'concept.mechanic', { min: 0, max: 500 });
  requireBoundedString(concept.feeling, 'concept.feeling', { min: 0, max: 240 });
  if (concept.feedback !== null) validateExperimentFeedback(concept.feedback, { required: true });
  validateConformanceMetrics(requirePlainObject(fields.conformance, 'conformance'));
  validateAutoplayMetrics(requirePlainObject(fields.autoplay, 'autoplay'));
  if (
    !Array.isArray(fields.files)
    || fields.files.length < 1
    || fields.files.length > 200
    || new Set(fields.files).size !== fields.files.length
    || fields.files.some(
      (file) => typeof file !== 'string'
        || file.length > 240
        || file.includes('..')
        || !SOURCE_FILE.test(file),
    )
  ) {
    throw contractError(
      'invalid_result',
      'files must be unique marble-sort-swipe/src/**.ts paths (the exact validateDiff domain)',
    );
  }
  const parent = buildParentBinding(fields.parent);
  const artifact = buildArtifactIdentity(fields.artifact);
  if (fields.baseCommit !== artifact.baseCommit || fields.baselineId !== artifact.baselineId) {
    throw contractError(
      'invalid_result',
      'top-level baseCommit/baselineId must equal the artifact identity',
    );
  }
  if (fields.url !== `/ugc/u/local-experiments/${fields.id}.html`) {
    throw contractError('invalid_result', 'url must derive from the experiment id');
  }
  if (fields.coverUrl !== `/ugc/u/local-experiments/${fields.id}.cover.png`) {
    throw contractError('invalid_result', 'coverUrl must derive from the experiment id');
  }
  if (parent !== null && parent.patchSha256 === artifact.patchSha256) {
    throw contractError('invalid_result', 'a tuning pass must change the parent patch');
  }
  return { parent, artifact };
}

export function buildWorkerResult(fields) {
  const { parent, artifact } = validateWorkerResultFields(fields);
  const result = { schema: WORKER_RESULT_SCHEMA, ...fields, parent, artifact };
  return { ...result, resultDigest: digestOf(result) };
}

export function verifyWorkerResult(result) {
  exactKeys(
    result,
    ['schema', 'resultDigest', ...RESULT_FIELD_KEYS],
    'worker result document',
  );
  if (result.schema !== WORKER_RESULT_SCHEMA) {
    throw contractError('invalid_result', 'unknown worker result schema');
  }
  const { schema, resultDigest, ...fields } = result;
  // Full domain re-validation: a re-signed document with a valid digest over
  // invalid claims (unproven autoplay, extra invocations, identity mismatch,
  // smuggled fields) must fail exactly like a byte-tampered one.
  validateWorkerResultFields(fields);
  if (digestOf({ schema, ...fields }) !== resultDigest) {
    throw contractError('result_digest_mismatch', 'worker result digest does not replay');
  }
  return result;
}

const FAILURE_CODE = /^[a-z][a-z0-9_]{2,64}$/;
const FAILURE_KEYS = ['code', 'message', 'model', 'parent', 'provider', 'schema'];
const HOME_DIR = process.env.HOME || '';

// Failure text leaves the machine, so it is redacted before it is signed:
// control characters collapse to spaces, ANSI sequences are dropped, local
// absolute paths lose the home prefix, and the length is bounded.
export function redactFailureMessage(raw) {
  let text = String(raw || '');
  text = text.replace(/\u001b\[[0-9;]*m/g, '');
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (HOME_DIR) text = text.split(HOME_DIR).join('~');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 2000);
}

export function buildWorkerFailure({ code, message, parent = null, provider = null, model = null }) {
  const safeCode = FAILURE_CODE.test(String(code || '')) ? String(code) : 'worker_failed';
  const failure = {
    schema: WORKER_FAILURE_SCHEMA,
    code: safeCode,
    message: redactFailureMessage(message),
    parent: parent === null ? null : buildParentBinding(parent),
    provider: provider === null || ['codex', 'claude'].includes(provider) ? provider : null,
    model: model === null ? null : String(model).slice(0, 80),
  };
  return { ...failure, failureDigest: digestOf(failure) };
}

// Exact verifier for the typed ERROR channel: consumers must reject anything
// that is not a well-formed, digest-replaying, redacted failure document.
export function verifyWorkerFailure(failure) {
  exactKeys(failure, [...FAILURE_KEYS, 'failureDigest'], 'worker failure document');
  if (failure.schema !== WORKER_FAILURE_SCHEMA) {
    throw contractError('invalid_failure', 'unknown worker failure schema');
  }
  if (!FAILURE_CODE.test(String(failure.code))) {
    throw contractError('invalid_failure', 'failure code must be a lowercase snake_case token');
  }
  if (typeof failure.message !== 'string' || failure.message.length > 2000
    || CONTROL_CHARS.test(failure.message) || failure.message !== redactFailureMessage(failure.message)) {
    throw contractError('invalid_failure', 'failure message must be bounded redacted text');
  }
  if (failure.provider !== null && !['codex', 'claude'].includes(failure.provider)) {
    throw contractError('invalid_failure', 'failure provider must be null, codex or claude');
  }
  if (failure.model !== null && (typeof failure.model !== 'string' || failure.model.length > 80)) {
    throw contractError('invalid_failure', 'failure model must be null or a bounded string');
  }
  if (failure.parent !== null) buildParentBinding(failure.parent);
  const { failureDigest, ...body } = failure;
  if (digestOf(body) !== failureDigest) {
    throw contractError('failure_digest_mismatch', 'worker failure digest does not replay');
  }
  return failure;
}
