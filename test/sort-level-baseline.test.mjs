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

function normalizedRuntimeDigest() {
  const placeholder = Buffer.from(`sha256:${'0'.repeat(64)}`);
  const embedded = Buffer.from(runtimeManifest.digest);
  const hash = createHash('sha256');
  hash.update(Buffer.from('swipe.runtime-artifact.normalized.v1\0'));
  let replacements = 0;
  const paths = runtimeManifest.files.map((entry) => entry.path);
  assert.deepEqual(paths, [...new Set(paths)].sort(), 'runtime executable allowlist must be unique and sorted');
  for (const entry of runtimeManifest.files) {
    const original = readFileSync(path.join(baseRoot, entry.path));
    assert.equal(original.length, entry.bytes);
    assert.equal(fileDigest(entry.path), entry.sha256);
    const bytes = Buffer.from(original);
    let offset = 0;
    while (offset <= bytes.length - embedded.length) {
      const index = bytes.indexOf(embedded, offset);
      if (index < 0) break;
      placeholder.copy(bytes, index);
      replacements += 1;
      offset = index + embedded.length;
    }
    const name = Buffer.from(entry.path);
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32BE(name.length);
    const byteLength = Buffer.alloc(8);
    byteLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(nameLength).update(name).update(byteLength).update(bytes);
  }
  assert.ok(replacements > 0, 'runtime files must embed their normalized digest');
  return `sha256:${hash.digest('hex')}`;
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

test('sort-v2-levels sidecar verifies its executable allowlist without hashing wrapper metadata', () => {
  assert.equal(runtimeManifest.files.some((entry) => entry.path === 'manifest.json'), false);
  assert.equal(normalizedRuntimeDigest(), runtimeManifest.digest);
});
