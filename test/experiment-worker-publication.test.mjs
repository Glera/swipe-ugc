// Publication and parent-closure hardening for the exact worker contract:
// append-only race-safe commits, hardened no-follow parent reads, and typed
// command-level failures with zero created artifacts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadParentClosure, publishExperimentResult } from '../worker/publish-local.mjs';
import { buildWorkerResult, sha256Hex } from '../worker/result-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.join(here, '..', 'worker', 'experiment.mjs');

function tempRoots() {
  const base = mkdtempSync(path.join(tmpdir(), 'worker-publication-'));
  return {
    base,
    localRoot: path.join(base, 'local'),
    artifactRoot: path.join(base, 'artifacts'),
  };
}

function candidate({ suffix = '', feedback = null } = {}) {
  return {
    fields: {
      id: `orbital-fixture-000${suffix || '1'}`,
      attemptUid: null,
      parent: null,
      baselineId: 'sort-v2',
      provider: 'claude',
      baseCommit: '7'.repeat(40),
      title: 'Orbital Fixture',
      concept: {
        prompt: 'fixture',
        feedback,
        pitch: 'fixture pitch',
        mechanic: 'fixture mechanic',
        feeling: 'fixture feeling',
      },
      autoplayPassed: true,
      wallTimeMs: 1000,
      agentInvocations: 1,
      playtestRuns: 1,
      conformance: { fps: 60 },
      autoplay: { outcome: 'won' },
      model: 'sonnet',
      effort: 'medium',
      testSeed: 7,
      files: ['marble-sort-swipe/src/main.ts'],
      agentSummary: 'fixture summary',
      createdAt: '2026-07-16T00:00:00.000Z',
      url: `/ugc/u/local-experiments/orbital-fixture-000${suffix || '1'}.html`,
      coverUrl: `/ugc/u/local-experiments/orbital-fixture-000${suffix || '1'}.cover.png`,
      coverBytes: 3,
    },
    html: `<html data-suffix="${suffix}"/>`,
    coverPng: Buffer.from([1, 2, suffix ? 9 : 3]),
    patch: `diff --git a b\n+fixture ${suffix}\n`,
  };
}

test('publication is append-only with identical replay and typed conflict', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const first = publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
    assert.equal(first.replayed, false);
    const committed = JSON.parse(
      readFileSync(path.join(localRoot, `${first.result.id}.json`), 'utf8'),
    );
    assert.equal(committed.resultDigest, first.result.resultDigest);

    // Identical bytes: exact replay of the committed candidate, no rewrite.
    const replay = publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.resultDigest, first.result.resultDigest);

    // Same id with different bytes: typed conflict, committed bytes intact.
    const conflicting = candidate({ suffix: '' });
    conflicting.html = '<html data-forged="true"/>';
    assert.throws(
      () => publishExperimentResult({ localRoot, artifactRoot, ...conflicting }),
      (error) => error.code === 'publish_conflict',
    );
    assert.equal(
      sha256Hex(readFileSync(path.join(artifactRoot, `${first.result.id}.html`))),
      first.result.artifact.htmlSha256,
    );
    assert.equal(readdirSync(localRoot).filter((name) => name.startsWith('.staging-')).length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('concurrent publication of one candidate yields one immutable result', async () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        (async () => publishExperimentResult({ localRoot, artifactRoot, ...candidate() }))(),
      ),
    );
    const digests = new Set(outcomes.map((item) => item.result.resultDigest));
    assert.equal(digests.size, 1);
    assert.equal(outcomes.filter((item) => !item.replayed).length >= 1, true);
    const manifests = readdirSync(localRoot).filter((name) => name.endsWith('.json'));
    assert.equal(manifests.length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function committedParent({ localRoot, artifactRoot }) {
  return publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
}

test('parent closure requires exact bytes and refuses symlinked pathnames', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const parent = committedParent({ localRoot, artifactRoot });
    const parentId = parent.result.id;
    const closure = loadParentClosure({ localRoot, artifactRoot, parentId });
    assert.equal(closure.binding.experimentId, parentId);
    assert.equal(closure.binding.patchSha256, parent.result.artifact.patchSha256);
    assert.equal(sha256Hex(closure.patchBytes), parent.result.artifact.patchSha256);

    // Pathname swap: replacing the patch with a symlink must be refused
    // before any bytes are read (O_NOFOLLOW), not silently followed.
    const patchPath = path.join(localRoot, `${parentId}.patch`);
    const lure = path.join(base, 'lure.patch');
    writeFileSync(lure, 'diff --git a b\n+swapped\n');
    rmSync(patchPath);
    symlinkSync(lure, patchPath);
    assert.throws(
      () => loadParentClosure({ localRoot, artifactRoot, parentId }),
      (error) => error.code === 'parent_unverifiable',
    );

    // Restored regular file with WRONG bytes: closure mismatch, typed.
    rmSync(patchPath);
    writeFileSync(patchPath, 'diff --git a b\n+swapped\n');
    assert.throws(
      () => loadParentClosure({ localRoot, artifactRoot, parentId }),
      (error) => error.code === 'parent_closure_mismatch',
    );

    // Legacy manifests without the typed schema cannot anchor a tuning pass.
    const legacyId = 'legacy-parent-000001';
    writeFileSync(path.join(localRoot, `${legacyId}.json`), JSON.stringify({ id: legacyId }));
    writeFileSync(path.join(localRoot, `${legacyId}.patch`), 'diff');
    assert.throws(
      () => loadParentClosure({ localRoot, artifactRoot, parentId: legacyId }),
      (error) => error.code === 'legacy_parent_unverifiable',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function runWorker(argv) {
  return spawnSync(process.execPath, [workerScript, ...argv], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('command level: invalid feedback is a typed single-line ERROR with exit 1', () => {
  const result = runWorker([
    '--provider', 'claude',
    '--parent', 'wild-sort-0123456789',
    '--feedback', '  padded  ',
  ]);
  assert.equal(result.status, 1);
  const line = result.stderr.split('\n').find((item) => item.startsWith('ERROR '));
  assert.ok(line, `expected a typed ERROR line, got: ${result.stderr.slice(0, 400)}`);
  const failure = JSON.parse(line.slice('ERROR '.length));
  assert.equal(failure.schema, 'ugc.experiment-worker-failure.v1');
  assert.equal(failure.code, 'invalid_feedback');
  assert.ok(!/\n\s+at /.test(result.stderr), 'stderr must not carry a stack trace');
});

test('command level: control characters and oversized feedback are refused', () => {
  for (const feedback of ['line\nbreak', 'x'.repeat(2001)]) {
    const result = runWorker([
      '--provider', 'claude',
      '--parent', 'wild-sort-0123456789',
      '--feedback', feedback,
    ]);
    assert.equal(result.status, 1);
    const line = result.stderr.split('\n').find((item) => item.startsWith('ERROR '));
    assert.ok(line);
    assert.equal(JSON.parse(line.slice('ERROR '.length)).code, 'invalid_feedback');
  }
});

test('command level: an unverifiable parent leaves zero created artifacts', () => {
  const repoRoot = path.join(here, '..');
  const localRoot = path.join(repoRoot, '.local-experiments');
  const before = existsSync(localRoot) ? readdirSync(localRoot).sort() : null;
  const result = runWorker([
    '--provider', 'claude',
    '--parent', 'missing-parent-000000',
    '--feedback', 'legitimate tuning instruction',
  ]);
  assert.equal(result.status, 1);
  const line = result.stderr.split('\n').find((item) => item.startsWith('ERROR '));
  assert.ok(line);
  const failure = JSON.parse(line.slice('ERROR '.length));
  assert.equal(failure.code, 'parent_unverifiable');
  const after = existsSync(localRoot) ? readdirSync(localRoot).sort() : null;
  assert.deepEqual(after, before, 'a refused run must not create artifacts');
});
