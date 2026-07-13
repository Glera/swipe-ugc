import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(path.join(root, 'generator', 'baselines.json'), 'utf8'));
const baseline = catalog.baselines['sort-v2-levels'];
const baseRoot = path.join(root, baseline.artifactPath);
const manifest = JSON.parse(readFileSync(path.join(baseRoot, 'manifest.json'), 'utf8'));
const runtimeManifest = JSON.parse(readFileSync(path.join(baseRoot, 'runtime-artifact.json'), 'utf8'));

function fileDigest(relative) {
  return `sha256:${createHash('sha256').update(readFileSync(path.join(baseRoot, relative))).digest('hex')}`;
}

test('sort-v2-levels baseline pins the LevelSpec runtime adapter and exact built artifact', () => {
  assert.equal(baseline.sourceCommit, manifest.sourceCommit);
  assert.equal(baseline.sourceTree, manifest.sourceTree);
  assert.equal(baseline.runtimeArtifactDigest, manifest.runtimeArtifactDigest);
  assert.equal(baseline.runtimeArtifactDigest, runtimeManifest.digest);
  assert.equal(manifest.capabilities.sortLevelSpecV1, true);
  assert.equal(manifest.capabilities.catalogRequiredHandshake, true);
  assert.equal(manifest.capabilities.logicalScheduler, false);
  assert.equal(manifest.capabilities.oracleQa, false);
  for (const [relative, digest] of Object.entries(manifest.files)) assert.equal(fileDigest(relative), digest);

  const executable = readFileSync(path.join(baseRoot, 'payload.js'), 'utf8');
  for (const marker of ['catalog_required', 'configure_ready', 'configure_level', 'configured', 'configure_failed']) {
    assert.equal(executable.includes(marker), true, `baseline payload is missing ${marker}`);
  }
});
