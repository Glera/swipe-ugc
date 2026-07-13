import { canonicalize, sha256Jcs } from '../recipes/sort/levels/index.mjs';

export const SORT_ORACLE_EFFORT_SCHEMA = 'sort.oracle-effort.v1';
export const SORT_ORACLE_EFFORT_UNIT = 'sort.oracle-effort-tick.v1';

const REPORT_FIELDS = [
  'actionTrace',
  'actions',
  'boardHash',
  'decisionPoints',
  'epoch',
  'fingerprint',
  'recoveryTicks',
  'schema',
  'specHash',
  'terminal',
  'ticks',
];

const SCORER = {
  schema: 'sort.oracle-effort-scorer.v1',
  mechanic: 'sort',
  input: {
    reportSchema: 'sort.logical-qa-report.v1',
    reportExactFields: REPORT_FIELDS,
    expectedOracleVersion: 'sort.oracle.v1',
    requiredVclockRuns: 2,
    requiredVclockAgreement: 'canonical-full-report',
    statusRules: {
      observed: 'matching-version-and-identical-reports-and-terminal-win',
      censored: 'matching-version-and-identical-reports-and-terminal-non-win',
      unavailable: 'oracle-version-mismatch-or-vclock-report-mismatch',
    },
    reasonPrecedence: ['oracle_version_mismatch', 'vclock_report_mismatch', 'terminal'],
    metricSource: 'vclockRuns[0]',
    traceValidation: 'sha256-jcs-chain-v1',
    includedMetrics: ['ticks', 'actions', 'decisionPoints', 'recoveryTicks'],
    excludedFromScore: ['difficultyTarget', 'mountMs', 'visualStates', 'realtimeSmoke'],
  },
  arithmetic: {
    representation: 'unsigned-integer',
    overflow: 'reject',
    rounding: 'none',
    unit: SORT_ORACLE_EFFORT_UNIT,
    formula: 'ticks*1+actions*60+decisionPoints*1+recoveryTicks*1',
    weights: { ticks: 1, actions: 60, decisionPoints: 1, recoveryTicks: 1 },
  },
  bounds: {
    epoch: [1, 0xffffffff],
    ticks: [0, 20000],
    actions: [0, 56],
    decisionPoints: [0, 20000],
    recoveryTicks: [0, 20000],
    cellId: [0, 55],
    score: [0, 63360],
  },
  output: {
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    unit: SORT_ORACLE_EFFORT_UNIT,
    exactFields: ['reason', 'schema', 'score', 'status', 'unit', 'version'],
    statusEnum: ['observed', 'censored', 'unavailable'],
    reasonEnum: [
      'oracle_win',
      'oracle_running',
      'oracle_loss',
      'oracle_version_mismatch',
      'vclock_report_mismatch',
    ],
    scoreByStatus: { observed: 'integer', censored: 'integer', unavailable: 'null' },
    banding: 'none',
  },
};

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const SORT_ORACLE_EFFORT_SCORER_V1 = deepFreeze(SCORER);
export const SORT_ORACLE_EFFORT_VERSION = `sha256:${sha256Jcs(SORT_ORACLE_EFFORT_SCORER_V1)}`;

const HASH = /^[a-f0-9]{64}$/;
const TERMINALS = new Set(['running', 'win', 'loss']);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} must contain exactly ${[...expected].sort().join(', ')}`);
  }
}

function boundedInteger(value, [minimum, maximum], label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateTrace(report, label) {
  if (!Array.isArray(report.actionTrace) || report.actionTrace.length !== report.actions) {
    throw new Error(`${label} actionTrace length must equal actions`);
  }
  let previous = '0'.repeat(64);
  for (let index = 0; index < report.actionTrace.length; index += 1) {
    const step = report.actionTrace[index];
    exactKeys(step, ['stateHash', 'action', 'nextStateHash', 'fingerprint'], `${label} actionTrace[${index}]`);
    exactKeys(step.action, ['type', 'cellId'], `${label} actionTrace[${index}].action`);
    if (step.action.type !== 'release') throw new Error(`${label} actionTrace[${index}] action type is invalid`);
    boundedInteger(step.action.cellId, SCORER.bounds.cellId, `${label} actionTrace[${index}] cellId`);
    for (const field of ['stateHash', 'nextStateHash', 'fingerprint']) {
      if (!HASH.test(String(step[field] || ''))) throw new Error(`${label} actionTrace[${index}] ${field} is invalid`);
    }
    const expected = sha256Jcs({
      previous,
      stateHash: step.stateHash,
      action: step.action,
      nextStateHash: step.nextStateHash,
    });
    if (step.fingerprint !== expected) throw new Error(`${label} actionTrace[${index}] fingerprint chain is invalid`);
    previous = step.fingerprint;
  }
  if (report.fingerprint !== previous) throw new Error(`${label} terminal fingerprint differs from actionTrace`);
}

function validateReport(value, label) {
  exactKeys(value, REPORT_FIELDS, label);
  if (value.schema !== SCORER.input.reportSchema) throw new Error(`${label} schema is invalid`);
  if (!HASH.test(String(value.specHash || ''))) throw new Error(`${label} specHash is invalid`);
  if (!HASH.test(String(value.boardHash || ''))) throw new Error(`${label} boardHash is invalid`);
  if (!HASH.test(String(value.fingerprint || ''))) throw new Error(`${label} fingerprint is invalid`);
  if (!TERMINALS.has(value.terminal)) throw new Error(`${label} terminal is invalid`);
  boundedInteger(value.epoch, SCORER.bounds.epoch, `${label} epoch`);
  boundedInteger(value.ticks, SCORER.bounds.ticks, `${label} ticks`);
  boundedInteger(value.actions, SCORER.bounds.actions, `${label} actions`);
  boundedInteger(value.decisionPoints, SCORER.bounds.decisionPoints, `${label} decisionPoints`);
  boundedInteger(value.recoveryTicks, SCORER.bounds.recoveryTicks, `${label} recoveryTicks`);
  if (value.decisionPoints > value.ticks) throw new Error(`${label} decisionPoints cannot exceed ticks`);
  if (value.recoveryTicks > value.ticks) throw new Error(`${label} recoveryTicks cannot exceed ticks`);
  validateTrace(value, label);
  return value;
}

export function validateSortOracleReport(value, label = 'Sort oracle report') {
  return validateReport(value, label);
}

function wire(status, score, reason) {
  return Object.freeze({
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    status,
    score,
    unit: SORT_ORACLE_EFFORT_UNIT,
    version: SORT_ORACLE_EFFORT_VERSION,
    reason,
  });
}

/**
 * Returns a deterministic oracle-effort observation, a right-censored effort
 * lower bound, or an explicit unavailable result. This is an operational
 * ordering index, not a player-perceived difficulty claim or label.
 */
export function scoreSortOracleEffort({
  firstReport,
  secondReport,
  firstOracleVersion,
  secondOracleVersion,
} = {}) {
  const first = validateReport(firstReport, 'first vclock report');
  const second = validateReport(secondReport, 'second vclock report');
  if (firstOracleVersion !== SCORER.input.expectedOracleVersion
    || secondOracleVersion !== SCORER.input.expectedOracleVersion) {
    return wire('unavailable', null, 'oracle_version_mismatch');
  }
  if (canonicalize(first) !== canonicalize(second)) {
    return wire('unavailable', null, 'vclock_report_mismatch');
  }

  const score = first.ticks
    + first.actions * SCORER.arithmetic.weights.actions
    + first.decisionPoints
    + first.recoveryTicks;
  boundedInteger(score, SCORER.bounds.score, 'oracle-effort score');
  if (first.terminal === 'win') return wire('observed', score, 'oracle_win');
  return wire('censored', score, first.terminal === 'loss' ? 'oracle_loss' : 'oracle_running');
}
