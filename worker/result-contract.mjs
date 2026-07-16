// Exact experiment-worker result contract (conformance slice).
//
// One physical model invocation = one job = one worker process = at most one
// typed RESULT. The worker never publishes success without a proven autoplay
// win and complete evidence; every success carries parent binding, artifact
// identity and a deterministic self-digest so the generator can verify the
// exact bytes it received.
import { createHash } from 'crypto';

export const WORKER_RESULT_SCHEMA = 'ugc.experiment-worker-result.v1';
export const WORKER_FAILURE_SCHEMA = 'ugc.experiment-worker-failure.v1';
export const FEEDBACK_MIN = 1;
export const FEEDBACK_MAX = 2000;

const HEX64 = /^[a-f0-9]{64}$/;
const EXPERIMENT_ID = /^[a-z0-9-]{8,80}$/;

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

// Feedback is exact operator/reviewer text: either absent (fresh experiment)
// or 1..2000 raw characters. The worker never truncates or rewrites it.
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
  return raw;
}

const PARENT_KEYS = ['experimentId', 'patchSha256'];
const ARTIFACT_KEYS = ['baseCommit', 'baselineId', 'coverSha256', 'htmlSha256', 'patchSha256'];

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
  if (!/^[a-f0-9]{40}$/.test(String(artifact.baseCommit))) {
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

const RESULT_KEYS = [
  'agentInvocations',
  'agentSummary',
  'artifact',
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
  'schema',
  'testSeed',
  'title',
  'url',
  'wallTimeMs',
];

export function buildWorkerResult(fields) {
  exactKeys(fields, RESULT_KEYS.filter((key) => key !== 'schema'), 'worker result');
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
  const result = {
    schema: WORKER_RESULT_SCHEMA,
    ...fields,
    parent: buildParentBinding(fields.parent),
    artifact: buildArtifactIdentity(fields.artifact),
  };
  return { ...result, resultDigest: digestOf(result) };
}

export function verifyWorkerResult(result) {
  const { resultDigest, ...body } = result;
  if (result.schema !== WORKER_RESULT_SCHEMA) {
    throw contractError('invalid_result', 'unknown worker result schema');
  }
  if (digestOf(body) !== resultDigest) {
    throw contractError('result_digest_mismatch', 'worker result digest does not replay');
  }
  return result;
}

export function buildWorkerFailure({ code, message, parent = null, provider = null, model = null }) {
  const failure = {
    schema: WORKER_FAILURE_SCHEMA,
    code: String(code || 'worker_failed'),
    message: String(message || '').slice(0, 5000),
    parent: parent === null ? null : buildParentBinding(parent),
    provider,
    model,
  };
  return { ...failure, failureDigest: digestOf(failure) };
}
