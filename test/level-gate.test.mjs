import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_ORACLE_VERSION,
  LEVEL_GATE_BASELINE_ID,
  LEVEL_GATE_GOLDEN_RESULT_SCHEMA,
  LEVEL_GATE_ORACLE_VERSION_DIGEST,
  LEVEL_GATE_REQUEST_SCHEMA,
  LEVEL_GATE_RESULT_SCHEMA,
  LEVEL_GATE_STDIN_LIMIT,
  classifyLevelRuns,
  resolveGoldenLevelGate,
} from '../worker/level-gate.mjs';
import {
  SORT_ORACLE_EFFORT_SCHEMA,
  SORT_ORACLE_EFFORT_UNIT,
  SORT_ORACLE_EFFORT_VERSION,
} from '../worker/sort-oracle-effort.mjs';
import { sha256Jcs } from '../recipes/sort/levels/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(root, 'worker', 'level-gate.mjs');
const baselineRoot = path.join(root, 'bases', LEVEL_GATE_BASELINE_ID);
const baselineBytes = readFileSync(path.join(baselineRoot, 'manifest.json'));
const baseline = JSON.parse(baselineBytes);
const fixture = JSON.parse(readFileSync(
  path.join(root, 'recipes', 'sort', 'levels', 'fixtures', 'sort-contract-golden.v1.json'),
  'utf8',
));

function gateRequest(overrides = {}) {
  return {
    schema: LEVEL_GATE_REQUEST_SCHEMA,
    childId: '90000000-0000-4000-8000-000000000001:1',
    leaseToken: '90000000-0000-4000-8000-000000000002',
    baseline: {
      id: baseline.id,
      manifestSha256: `sha256:${createHash('sha256').update(baselineBytes).digest('hex')}`,
      runtimeArtifactDigest: baseline.runtimeArtifactDigest,
      runtimeContractDigest: baseline.runtimeContractDigest,
      sourceCommit: baseline.sourceCommit,
      sourceTree: baseline.sourceTree,
    },
    spec: fixture.levelSpecs[0].spec,
    ...overrides,
  };
}

function qaRun(overrides = {}) {
  return {
    oracleVersion: EXPECTED_ORACLE_VERSION,
    visualStates: 2,
    report: {
      schema: 'sort.logical-qa-report.v1',
      specHash: fixture.levelSpecs[0].spec.specHash,
      ticks: 1183,
      boardHash: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      actions: 6,
      decisionPoints: 130,
      recoveryTicks: 515,
      terminal: 'win',
    },
    ...overrides,
  };
}

test('level verdicts preserve pass, inconclusive, and flake semantics', () => {
  const first = qaRun();
  const second = structuredClone(first);
  const realtime = { ...qaRun(), timedOut: false };
  assert.deepEqual(classifyLevelRuns(first, second, realtime), { verdict: 'pass', reason: 'verified' });

  const running = qaRun({ report: { ...first.report, terminal: 'running' } });
  assert.deepEqual(classifyLevelRuns(running, structuredClone(running)), {
    verdict: 'inconclusive', reason: 'oracle_did_not_win',
  });

  const divergent = qaRun({ report: { ...first.report, boardHash: 'c'.repeat(64) } });
  assert.deepEqual(classifyLevelRuns(first, divergent), {
    verdict: 'flake', reason: 'vclock_report_mismatch',
  });
  assert.deepEqual(classifyLevelRuns(first, second, { ...realtime, timedOut: true }), {
    verdict: 'flake', reason: 'realtime_smoke_mismatch',
  });
});

test('bounded stdin rejects oversized gate requests before any browser work', () => {
  const run = spawnSync(process.execPath, [gate], {
    cwd: root,
    input: Buffer.alloc(LEVEL_GATE_STDIN_LIMIT + 1, 0x20),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /request exceeds 262144 bytes/);
  assert.doesNotMatch(run.stdout, /qa-vclock|qa-realtime/);
});

test('--identity emits only the frozen QA execution identity without stdin', () => {
  const run = spawnSync(process.execPath, [gate, '--identity'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.trim().split(/\r?\n/).length, 1);
  const identity = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(identity).sort(), [
    'browserRuntimeDigest', 'gateVersion', 'oracleVersion', 'platform', 'policyDigest', 'schema',
  ]);
  assert.equal(identity.schema, 'sort.qa-execution.v1');
  assert.equal(identity.oracleVersion, LEVEL_GATE_ORACLE_VERSION_DIGEST);
  for (const field of ['browserRuntimeDigest', 'gateVersion', 'oracleVersion', 'policyDigest']) {
    assert.match(identity[field], /^sha256:[0-9a-f]{64}$/);
  }
});

test('--golden resolves only the canonical recipe, LevelSpec, and artifact pin', () => {
  const golden = resolveGoldenLevelGate(137);
  assert.equal(golden.fixture, 'baseline-medium-seed-137');
  assert.equal(golden.recipeDigest, fixture.recipe.version.recipeDigest);
  assert.deepEqual(golden.request.spec, fixture.levelSpecs[0].spec);
  assert.equal(golden.request.baseline.id, LEVEL_GATE_BASELINE_ID);
  assert.match(golden.request.baseline.manifestSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(golden.request.baseline.runtimeArtifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(golden.request.baseline.runtimeContractDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(golden.request.baseline.runtimeContractDigest, /^sha256:/);
  assert.equal(golden.request.spec.runtimeContractDigest, golden.request.baseline.runtimeContractDigest);
  assert.throws(() => resolveGoldenLevelGate(138), /canonical golden LevelSpec.*unavailable/i);
  assert.throws(() => resolveGoldenLevelGate(-1), /unsigned 32-bit integer/i);
});

test('gate rejects a baseline pin outside the canonical Sort runtime contract before browser work', () => {
  const request = gateRequest();
  request.baseline.runtimeContractDigest = '0'.repeat(64);
  const run = spawnSync(process.execPath, [gate], {
    cwd: root,
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /incompatible with the canonical Sort runtime contract/);
  assert.doesNotMatch(run.stdout, /qa-vclock|qa-realtime/);
});

test('level-gate CLI verifies the pinned artifact, repeats vclock, and passes realtime smoke', { timeout: 120000 }, () => {
  const run = spawnSync(process.execPath, [gate], {
    cwd: root,
    input: JSON.stringify(gateRequest()),
    encoding: 'utf8',
    timeout: 110000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const lines = run.stdout.trim().split(/\r?\n/);
  assert.deepEqual(lines.filter((line) => line.startsWith('STATUS ')).map((line) => JSON.parse(line.slice(7)).phase), [
    'qa-verify', 'qa-vclock', 'qa-realtime',
  ]);
  const resultLine = lines.find((line) => line.startsWith('RESULT '));
  assert.ok(resultLine, run.stdout);
  const result = JSON.parse(resultLine.slice(7));
  assert.equal(result.schema, LEVEL_GATE_RESULT_SCHEMA);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reason, 'verified');
  assert.deepEqual(result.difficulty, {
    schema: SORT_ORACLE_EFFORT_SCHEMA,
    status: 'observed',
    score: 2188,
    unit: SORT_ORACLE_EFFORT_UNIT,
    version: SORT_ORACLE_EFFORT_VERSION,
    reason: 'oracle_win',
  });
  assert.deepEqual(Object.keys(result.difficulty).sort(), [
    'reason', 'schema', 'score', 'status', 'unit', 'version',
  ]);
  assert.equal(result.specHash, fixture.levelSpecs[0].spec.specHash);
  assert.equal(result.baseline.runtimeArtifactDigest, baseline.runtimeArtifactDigest);
  assert.equal(result.vclockRuns.length, 2);
  assert.deepEqual(
    result.vclockRuns.map((item) => ({
      ticks: item.ticks,
      boardHash: item.boardHash,
      fingerprint: item.fingerprint,
      terminal: item.terminal,
    })),
    [0, 1].map(() => ({
      ticks: 1183,
      boardHash: '9649087ad280abb3b29a9077d118bbbddc97eeec76ee29e9ac4a5ff9d627bbf9',
      fingerprint: '8e69981b7882116f12103fdfd49bfacbaac4420c34fc1ad24fccb0a2c45f7b9c',
      terminal: 'win',
    })),
  );
  assert.equal(result.realtimeSmoke.terminal, 'win');
  assert.equal(result.realtimeSmoke.timedOut, false);
  assert.deepEqual(result.vclockRuns.map((item) => item.oracleVersion), ['sort.oracle.v1', 'sort.oracle.v1']);
  assert.equal(result.realtimeSmoke.oracleVersion, 'sort.oracle.v1');
  assert.deepEqual(result.vclockRuns.map((item) => item.epoch), [1, 1]);
  assert.deepEqual(result.vclockRuns.map((item) => item.actionTrace.map((step) => step.action.cellId)), [
    [48, 50, 40, 49, 51, 41],
    [48, 50, 40, 49, 51, 41],
  ]);
  assert.deepEqual(result.realtimeSmoke.actionTrace.map((step) => step.action.cellId), [48, 50, 40, 49, 51, 41]);
  assert.ok(Buffer.byteLength(run.stdout) < 128 * 1024, 'actual golden gate stdout stays below the executor line cap');

  const environmentWithoutCacheKey = { ...result.environment };
  delete environmentWithoutCacheKey.cacheKey;
  assert.equal(result.environment.cacheKey, `sha256:${sha256Jcs(environmentWithoutCacheKey)}`);
  for (const field of ['runtimeArtifactDigest', 'gateVersion', 'browserRuntimeDigest', 'policyDigest', 'cacheKey']) {
    assert.match(result.environment[field], /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(result.environment.specHash, result.specHash);
  assert.equal(result.environment.oracleVersion, LEVEL_GATE_ORACLE_VERSION_DIGEST);
  assert.match(result.environment.platform, /^[a-z0-9._-]+$/i);
});

test('--golden 137 runs the trusted gate and emits one compact reproducible JSON line', { timeout: 120000 }, () => {
  const run = spawnSync(process.execPath, [gate, '--golden', '137'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.trim().split(/\r?\n/).length, 1);
  assert.ok(Buffer.byteLength(run.stdout) < 4096, 'golden DX output must remain compact');
  const result = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(result).sort(), [
    'difficulty', 'fixture', 'metrics', 'oracle', 'reason', 'recipeDigest', 'runtimeArtifactDigest',
    'runtimeContractDigest', 'schema', 'seed', 'specHash', 'verdict',
  ]);
  assert.equal(result.schema, LEVEL_GATE_GOLDEN_RESULT_SCHEMA);
  assert.equal(result.fixture, 'baseline-medium-seed-137');
  assert.equal(result.seed, 137);
  assert.equal(result.recipeDigest, fixture.recipe.version.recipeDigest);
  assert.equal(result.specHash, fixture.levelSpecs[0].spec.specHash);
  assert.match(result.runtimeArtifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.runtimeContractDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reason, 'verified');
  assert.equal(result.difficulty.score, 2188);
  assert.deepEqual(result.metrics, {
    ticks: 1183,
    actions: 6,
    decisionPoints: 130,
    recoveryTicks: 515,
    visualStates: 2,
  });
  assert.deepEqual(result.oracle, {
    version: 'sort.oracle.v1',
    vclockRuns: 2,
    vclockIdentical: true,
    terminal: 'win',
    boardHash: '9649087ad280abb3b29a9077d118bbbddc97eeec76ee29e9ac4a5ff9d627bbf9',
    fingerprint: '8e69981b7882116f12103fdfd49bfacbaac4420c34fc1ad24fccb0a2c45f7b9c',
    realtimeTerminal: 'win',
    realtimeTimedOut: false,
  });
  assert.equal(Object.hasOwn(result.metrics, 'mountMs'), false);
});
