import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SORT_LEVEL_QA_BASELINE,
} from '../scripts/build-sort-level-qa-baseline.mjs';
import {
  sha256File,
  verifyRuntimeArtifact,
} from '../scripts/runtime-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(path.join(root, 'generator', 'baselines.json'), 'utf8'));

function baseline(id) {
  const descriptor = catalog.baselines[id];
  const artifactRoot = path.join(root, descriptor.artifactPath);
  const manifest = JSON.parse(readFileSync(path.join(artifactRoot, 'manifest.json'), 'utf8'));
  const runtimeManifest = verifyRuntimeArtifact(artifactRoot).manifest;
  return { descriptor, artifactRoot, manifest, runtimeManifest };
}

function assertPinnedFiles(artifactRoot, manifest) {
  for (const [relative, digest] of Object.entries(manifest.files)) {
    assert.equal(sha256File(path.join(artifactRoot, relative)), digest, relative);
  }
}

test('sort-v2-levels remains the immutable pre-scheduler equivalence baseline', () => {
  const current = baseline('sort-v2-levels');
  assert.equal(current.descriptor.sourceCommit, current.manifest.sourceCommit);
  assert.equal(current.descriptor.sourceTree, current.manifest.sourceTree);
  assert.equal(current.descriptor.runtimeArtifactDigest, current.manifest.runtimeArtifactDigest);
  assert.equal(current.descriptor.runtimeArtifactDigest, current.runtimeManifest.digest);
  assert.equal(current.manifest.capabilities.sortLevelSpecV1, true);
  assert.equal(current.manifest.capabilities.catalogRequiredHandshake, true);
  assert.equal(current.manifest.capabilities.logicalScheduler, false);
  assert.equal(current.manifest.capabilities.oracleQa, false);
  assert.equal(current.manifest.releasePlayable, false);
  assertPinnedFiles(current.artifactRoot, current.manifest);

  const executable = readFileSync(path.join(current.artifactRoot, 'payload.js'), 'utf8');
  for (const marker of ['catalog_required', 'configure_ready', 'configure_level', 'configured', 'configure_failed']) {
    assert.equal(executable.includes(marker), true, `equivalence payload is missing ${marker}`);
  }
});

test('sort-v2-levels sidecar verifies its executable allowlist without hashing wrapper metadata', () => {
  const current = baseline('sort-v2-levels');
  assert.equal(current.runtimeManifest.files.some((entry) => entry.path === 'manifest.json'), false);
  assert.equal(current.runtimeManifest.digest, current.descriptor.runtimeArtifactDigest);
});

test('sort-v2-levels-qa pins the logical scheduler and oracle runtime for server-side QA', () => {
  const current = baseline(SORT_LEVEL_QA_BASELINE.id);
  for (const field of ['sourceCommit', 'sourceTree', 'sourcePath', 'runtimeContractDigest']) {
    assert.equal(current.descriptor[field], SORT_LEVEL_QA_BASELINE[field], `descriptor ${field}`);
    assert.equal(current.manifest[field], SORT_LEVEL_QA_BASELINE[field], `manifest ${field}`);
  }
  assert.equal(current.descriptor.artifactPath, `bases/${SORT_LEVEL_QA_BASELINE.id}`);
  assert.equal(current.descriptor.runtimeArtifactDigest, SORT_LEVEL_QA_BASELINE.runtimeArtifactDigest);
  assert.equal(current.descriptor.runtimeArtifactDigest, current.runtimeManifest.digest);
  assert.equal(current.manifest.runtimeArtifactDigest, current.runtimeManifest.digest);
  assert.deepEqual(current.descriptor.capabilities, SORT_LEVEL_QA_BASELINE.capabilities);
  assert.deepEqual(current.manifest.capabilities, SORT_LEVEL_QA_BASELINE.capabilities);
  assert.equal(current.manifest.purpose, 'level-spec-oracle-qa-base-only');
  assert.equal(current.descriptor.releasePlayable, false);
  assert.equal(current.manifest.releasePlayable, false);
  assert.equal(current.runtimeManifest.sourceCommit, SORT_LEVEL_QA_BASELINE.sourceCommit);
  assert.equal(current.runtimeManifest.playableId, SORT_LEVEL_QA_BASELINE.sourcePath);
  assert.equal(current.runtimeManifest.files.some((entry) => entry.path === 'manifest.json'), false);
  assertPinnedFiles(current.artifactRoot, current.manifest);

  const executable = readFileSync(path.join(current.artifactRoot, 'payload.js'), 'utf8');
  for (const marker of [
    SORT_LEVEL_QA_BASELINE.runtimeContractDigest,
    'catalog_required',
    'sortQa',
    'advanceTicks',
    'chooseOracleAction',
    'applyOracleAction',
  ]) {
    assert.equal(executable.includes(marker), true, `QA payload is missing ${marker}`);
  }
});

test('QA and equivalence baselines remain distinct immutable artifacts', () => {
  const equivalence = baseline('sort-v2-levels');
  const qa = baseline(SORT_LEVEL_QA_BASELINE.id);
  assert.notEqual(qa.descriptor.sourceCommit, equivalence.descriptor.sourceCommit);
  assert.notEqual(qa.runtimeManifest.digest, equivalence.runtimeManifest.digest);
  assert.equal(equivalence.runtimeManifest.digest, 'sha256:9b73a1fbbbfed04322b2bf7d3260d2af69816172d2e7a3b975d1f2b8e0c65a3d');
});

test('runtime artifact CLI emits only the verified digest and fails closed', () => {
  const script = path.join(root, 'scripts', 'runtime-artifact.mjs');
  const qa = baseline(SORT_LEVEL_QA_BASELINE.id);
  const verified = spawnSync(process.execPath, [script, '--verify', qa.artifactRoot], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, '');
  assert.equal(verified.stdout, `${qa.runtimeManifest.digest}\n`);

  const rejected = spawnSync(process.execPath, [script, '--verify', path.join(root, 'bases', 'missing')], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /ENOENT|runtime artifact root/);
});
