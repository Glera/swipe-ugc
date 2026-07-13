import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalize, sha256Jcs } from '../recipes/sort/levels/index.mjs';
import {
  SORT_ORACLE_EFFORT_SCHEMA,
  SORT_ORACLE_EFFORT_SCORER_V1,
  SORT_ORACLE_EFFORT_UNIT,
  SORT_ORACLE_EFFORT_VERSION,
  scoreSortOracleEffort,
} from '../worker/sort-oracle-effort.mjs';

const SPEC_HASH = '12b1a5fe32e77e8779d3fc25fda12750c02737390beeabb660f7b3725333dbaa';
const VERSION = 'sha256:21e999a5176787bb5f1ab831d355979aff9a3781a136e98d13f754cfab5c637e';
const ACTION_CELLS = [48, 50, 40, 49, 51, 41];

function actionTrace(cells = ACTION_CELLS) {
  let previous = '0'.repeat(64);
  return cells.map((cellId, index) => {
    const stateHash = sha256Jcs({ schema: 'test.oracle-state.v1', index, side: 'before' });
    const nextStateHash = sha256Jcs({ schema: 'test.oracle-state.v1', index, side: 'after' });
    const action = { type: 'release', cellId };
    const fingerprint = sha256Jcs({ previous, stateHash, action, nextStateHash });
    previous = fingerprint;
    return { stateHash, action, nextStateHash, fingerprint };
  });
}

function report(overrides = {}) {
  const trace = actionTrace();
  return {
    schema: 'sort.logical-qa-report.v1',
    specHash: SPEC_HASH,
    epoch: 1,
    ticks: 1183,
    boardHash: sha256Jcs({ schema: 'test.oracle-board.v1', terminal: 'win' }),
    fingerprint: trace.at(-1).fingerprint,
    actions: trace.length,
    decisionPoints: 130,
    recoveryTicks: 515,
    terminal: 'win',
    actionTrace: trace,
    ...overrides,
  };
}

function eligibleInput(overrides = {}) {
  const firstReport = report();
  return {
    firstReport,
    secondReport: structuredClone(firstReport),
    firstOracleVersion: 'sort.oracle.v1',
    secondOracleVersion: 'sort.oracle.v1',
    ...overrides,
  };
}

test('oracle-effort scorer identity and wire contract are frozen', () => {
  assert.equal(SORT_ORACLE_EFFORT_VERSION, VERSION);
  assert.equal(SORT_ORACLE_EFFORT_SCORER_V1.schema, 'sort.oracle-effort-scorer.v1');
  assert.equal(SORT_ORACLE_EFFORT_SCORER_V1.output.banding, 'none');
  assert.deepEqual(SORT_ORACLE_EFFORT_SCORER_V1.output.exactFields, [
    'reason', 'schema', 'score', 'status', 'unit', 'version',
  ]);
  assert.match(canonicalize(SORT_ORACLE_EFFORT_SCORER_V1), /"difficultyTarget"/);
  assert.equal(Object.isFrozen(SORT_ORACLE_EFFORT_SCORER_V1.input), true);
  assert.equal(Object.isFrozen(SORT_ORACLE_EFFORT_SCORER_V1.arithmetic.weights), true);
});

test('seed 137 golden metrics produce exact integer oracle effort', () => {
  const difficulty = scoreSortOracleEffort({ ...eligibleInput(), difficultyTarget: 'expert' });
  assert.deepEqual(difficulty, {
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    status: 'observed',
    score: 2188,
    unit: SORT_ORACLE_EFFORT_UNIT,
    version: VERSION,
    reason: 'oracle_win',
  });
  assert.deepEqual(Object.keys(difficulty).sort(), ['reason', 'schema', 'score', 'status', 'unit', 'version']);
  assert.equal(Number.isInteger(difficulty.score), true);
  assert.equal(Object.isFrozen(difficulty), true);
});

test('scorer rejects malformed reports and trace evidence', () => {
  assert.throws(
    () => scoreSortOracleEffort(eligibleInput({ firstReport: report({ ticks: 1183.5 }) })),
    /ticks must be an integer/,
  );
  assert.throws(
    () => scoreSortOracleEffort(eligibleInput({ firstReport: { ...report(), unexpected: true } })),
    /must contain exactly/,
  );
  const brokenTrace = report();
  brokenTrace.actionTrace[2].fingerprint = 'f'.repeat(64);
  brokenTrace.fingerprint = brokenTrace.actionTrace.at(-1).fingerprint;
  assert.throws(
    () => scoreSortOracleEffort(eligibleInput({ firstReport: brokenTrace })),
    /fingerprint chain is invalid/,
  );
  assert.throws(
    () => scoreSortOracleEffort(eligibleInput({ firstReport: report({ decisionPoints: 1184 }) })),
    /decisionPoints cannot exceed ticks/,
  );
});

test('scorer distinguishes observed, censored, and unavailable evidence', () => {
  const divergent = report({ boardHash: 'c'.repeat(64) });
  assert.deepEqual(scoreSortOracleEffort(eligibleInput({ secondReport: divergent })), {
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    status: 'unavailable',
    score: null,
    unit: SORT_ORACLE_EFFORT_UNIT,
    version: VERSION,
    reason: 'vclock_report_mismatch',
  });

  const running = report({ terminal: 'running' });
  assert.deepEqual(scoreSortOracleEffort(eligibleInput({
    firstReport: running,
    secondReport: structuredClone(running),
  })), {
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    status: 'censored',
    score: 2188,
    unit: SORT_ORACLE_EFFORT_UNIT,
    version: VERSION,
    reason: 'oracle_running',
  });

  const loss = report({ terminal: 'loss' });
  assert.equal(scoreSortOracleEffort(eligibleInput({
    firstReport: loss,
    secondReport: structuredClone(loss),
  })).reason, 'oracle_loss');

  assert.deepEqual(scoreSortOracleEffort(eligibleInput({
    firstOracleVersion: 'sort.oracle.v0',
    secondReport: divergent,
  })), {
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    status: 'unavailable',
    score: null,
    unit: SORT_ORACLE_EFFORT_UNIT,
    version: VERSION,
    reason: 'oracle_version_mismatch',
  });
});

test('three maximum 56-action evidence summaries fit one 128 KiB RESULT line', () => {
  const trace = actionTrace(Array.from({ length: 56 }, (_, index) => index));
  const maximal = report({
    ticks: 20000,
    actions: 56,
    decisionPoints: 20000,
    recoveryTicks: 20000,
    fingerprint: trace.at(-1).fingerprint,
    actionTrace: trace,
  });
  const vclock = {
    ...maximal, oracleVersion: 'sort.oracle.v1', mountMs: 15000, visualStates: 2,
  };
  const realtime = {
    ...maximal, oracleVersion: 'sort.oracle.v1', mountMs: 15000, timedOut: false,
  };
  const resultLine = `RESULT ${JSON.stringify({
    schema: 'sort.level-gate-result.v1',
    childId: 'a'.repeat(64),
    leaseToken: '90000000-0000-4000-8000-000000000002',
    specHash: SPEC_HASH,
    baseline: {
      id: 'sort-v2-levels-qa',
      manifestSha256: `sha256:${'a'.repeat(64)}`,
      runtimeArtifactDigest: `sha256:${'b'.repeat(64)}`,
      runtimeContractDigest: 'c'.repeat(64),
      sourceCommit: 'd'.repeat(40),
      sourceTree: 'e'.repeat(40),
    },
    environment: {
      schema: 'sort.level-qa-cache-key.v1',
      specHash: SPEC_HASH,
      runtimeArtifactDigest: `sha256:${'b'.repeat(64)}`,
      gateVersion: `sha256:${'f'.repeat(64)}`,
      browserRuntimeDigest: `sha256:${'1'.repeat(64)}`,
      platform: 'darwin-arm64-test',
      oracleVersion: `sha256:${'2'.repeat(64)}`,
      policyDigest: `sha256:${'3'.repeat(64)}`,
      cacheKey: `sha256:${'4'.repeat(64)}`,
    },
    verdict: 'pass',
    reason: 'verified',
    difficulty: {
      schema: SORT_ORACLE_EFFORT_SCHEMA,
      status: 'observed',
      score: 63360,
      unit: SORT_ORACLE_EFFORT_UNIT,
      version: VERSION,
      reason: 'oracle_win',
    },
    metrics: {
      ticks: 20000, actions: 56, decisionPoints: 20000, recoveryTicks: 20000,
      mountMs: 15000, visualStates: 2,
    },
    vclockRuns: [vclock, structuredClone(vclock)],
    realtimeSmoke: realtime,
  })}`;
  assert.ok(Buffer.byteLength(resultLine) < 128 * 1024, `maximal RESULT is ${Buffer.byteLength(resultLine)} bytes`);
});
