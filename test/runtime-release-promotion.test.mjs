import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
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

import Ajv2020 from 'ajv/dist/2020.js';

import { canonicalize } from '../recipes/sort/levels/jcs.mjs';
import {
  RUNTIME_RELEASE_DESCRIPTOR,
  promoteRuntimeRelease,
} from '../scripts/promote-runtime-release.mjs';
import { verifyRuntimeArtifact } from '../worker/runtime-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = path.join(root, 'bases', 'sort-v2-levels-qa');
const catalogFile = path.join(root, 'generator', 'baselines.json');
const script = path.join(root, 'scripts', 'promote-runtime-release.mjs');
const expectedDigest = 'sha256:d66b4e440358533410dd505f25b7558187df46ca5d8eea562d8648c62f2f9293';
const expectedHex = expectedDigest.slice('sha256:'.length);
const expectedRelative = `runtime-releases/marble-sort-swipe/${expectedHex}`;

function scratch(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'runtime-release-promotion-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const platformRoot = path.join(directory, 'platform');
  mkdirSync(platformRoot);
  return { directory, platformRoot };
}

function options(platformRoot, extra = {}) {
  return {
    baselineRoot,
    catalogFile,
    platformRoot,
    ...extra,
  };
}

test('check mode resolves the real d66b Sort QA identity without writing', (t) => {
  const { platformRoot } = scratch(t);
  const result = promoteRuntimeRelease(options(platformRoot));

  assert.equal(result.status, 'would_create');
  assert.equal(result.mode, 'check');
  assert.equal(result.target, expectedRelative);
  assert.equal(result.descriptor.schema, 'runtime-release.v1');
  assert.equal(result.descriptor.releasePlayable, true);
  assert.equal(result.descriptor.mechanic, 'sort');
  assert.equal(result.descriptor.variant, 'base');
  assert.equal(result.descriptor.playableId, 'marble-sort-swipe');
  assert.equal(result.descriptor.qaBaselineId, 'sort-v2-levels-qa');
  assert.equal(result.descriptor.runtimeArtifactDigest, expectedDigest);
  assert.equal(result.descriptor.runtimeContractDigest, 'c79a84694f02dad356822fa1b3f3d039b8f056f23f1300ff536a072e54c3b625');
  assert.equal(result.descriptor.indexPath, 'index.html');
  assert.equal(result.descriptor.sidecarPath, 'runtime-artifact.json');
  assert.equal(existsSync(path.join(platformRoot, 'runtime-releases')), false);

  const schema = JSON.parse(readFileSync(path.join(root, 'schemas', 'runtime-release.v1.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(result.descriptor), true, JSON.stringify(validate.errors));
});

test('CLI defaults to check and leaves the target platform byte-for-byte untouched', (t) => {
  const { platformRoot } = scratch(t);
  const before = readdirSync(platformRoot);
  const run = spawnSync(process.execPath, [script, '--platform', platformRoot], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const output = JSON.parse(run.stdout);
  assert.equal(output.status, 'would_create');
  assert.equal(output.target, expectedRelative);
  assert.deepEqual(readdirSync(platformRoot), before);
});

test('write copies only sidecar-declared bytes and a canonical release descriptor', (t) => {
  const { platformRoot } = scratch(t);
  const created = promoteRuntimeRelease(options(platformRoot, { mode: 'write' }));
  assert.equal(created.status, 'created');

  const target = path.join(platformRoot, ...created.target.split('/'));
  assert.deepEqual(readdirSync(target).sort(), [
    'index.html',
    'payload.js',
    'runtime-artifact.json',
    RUNTIME_RELEASE_DESCRIPTOR,
  ]);
  assert.equal(existsSync(path.join(target, 'manifest.json')), false, 'QA wrapper must never enter a release');
  for (const relative of ['index.html', 'payload.js', 'runtime-artifact.json']) {
    assert.deepEqual(readFileSync(path.join(target, relative)), readFileSync(path.join(baselineRoot, relative)), relative);
  }

  const descriptorBytes = readFileSync(path.join(target, RUNTIME_RELEASE_DESCRIPTOR));
  const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
  assert.equal(descriptorBytes.toString('utf8'), canonicalize(descriptor));
  assert.deepEqual(descriptor, created.descriptor);
  assert.equal(verifyRuntimeArtifact(target, {
    expectedDigest,
    expectedPlayableId: 'marble-sort-swipe',
    wrapperMetadata: [RUNTIME_RELEASE_DESCRIPTOR],
  }).digest, expectedDigest);

  const replay = promoteRuntimeRelease(options(platformRoot, { mode: 'write' }));
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.descriptor, created.descriptor);
  const checked = promoteRuntimeRelease(options(platformRoot, { mode: 'check' }));
  assert.equal(checked.status, 'replayed');
});

test('an existing content-addressed directory fails closed on byte mismatch or extras', async (t) => {
  await t.test('byte mismatch', (child) => {
    const { platformRoot } = scratch(child);
    const created = promoteRuntimeRelease(options(platformRoot, { mode: 'write' }));
    const target = path.join(platformRoot, ...created.target.split('/'));
    writeFileSync(path.join(target, 'payload.js'), Buffer.from('tampered'));
    assert.throws(
      () => promoteRuntimeRelease(options(platformRoot, { mode: 'write' })),
      /existing runtime release byte mismatch: payload\.js/,
    );
  });

  await t.test('undeclared extra file', (child) => {
    const { platformRoot } = scratch(child);
    const created = promoteRuntimeRelease(options(platformRoot, { mode: 'write' }));
    const target = path.join(platformRoot, ...created.target.split('/'));
    writeFileSync(path.join(target, 'manifest.json'), '{}');
    assert.throws(
      () => promoteRuntimeRelease(options(platformRoot, { mode: 'check' })),
      /file set differs/,
    );
  });
});

test('source wrapper, executable, and pin tampering are rejected before platform writes', async (t) => {
  async function copiedBaseline(child) {
    const { directory, platformRoot } = scratch(child);
    const copy = path.join(directory, 'qa');
    cpSync(baselineRoot, copy, { recursive: true });
    return { copy, platformRoot };
  }

  await t.test('releasePlayable flip', async (child) => {
    const { copy, platformRoot } = await copiedBaseline(child);
    const wrapperFile = path.join(copy, 'manifest.json');
    const wrapper = JSON.parse(readFileSync(wrapperFile, 'utf8'));
    wrapper.releasePlayable = true;
    writeFileSync(wrapperFile, `${JSON.stringify(wrapper)}\n`);
    assert.throws(
      () => promoteRuntimeRelease(options(platformRoot, { baselineRoot: copy })),
      /releasePlayable:false/,
    );
    assert.equal(existsSync(path.join(platformRoot, 'runtime-releases')), false);
  });

  await t.test('executable tamper', async (child) => {
    const { copy, platformRoot } = await copiedBaseline(child);
    writeFileSync(path.join(copy, 'payload.js'), Buffer.from('tampered'));
    assert.throws(
      () => promoteRuntimeRelease(options(platformRoot, { baselineRoot: copy })),
      /integrity mismatch|normalized digest mismatch/,
    );
    assert.equal(existsSync(path.join(platformRoot, 'runtime-releases')), false);
  });

  await t.test('source identity pin drift', async (child) => {
    const { copy, platformRoot } = await copiedBaseline(child);
    const wrapperFile = path.join(copy, 'manifest.json');
    const wrapper = JSON.parse(readFileSync(wrapperFile, 'utf8'));
    wrapper.sourceTree = '0'.repeat(40);
    writeFileSync(wrapperFile, `${JSON.stringify(wrapper)}\n`);
    assert.throws(
      () => promoteRuntimeRelease(options(platformRoot, { baselineRoot: copy })),
      /does not match its immutable baseline pin/,
    );
  });
});

test('destination symlinks and path-like identifiers fail without escaping platform', async (t) => {
  await t.test('symlinked release root', (child) => {
    const { directory, platformRoot } = scratch(child);
    const outside = path.join(directory, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(platformRoot, 'runtime-releases'), 'dir');
    assert.throws(
      () => promoteRuntimeRelease(options(platformRoot, { mode: 'write' })),
      /non-symlink directory/,
    );
    assert.deepEqual(readdirSync(outside), []);
  });

  await t.test('unsafe mechanic and variant', () => {
    const { platformRoot } = scratch(t);
    assert.throws(() => promoteRuntimeRelease(options(platformRoot, { mechanic: '../sort' })), /safe path segment/);
    assert.throws(() => promoteRuntimeRelease(options(platformRoot, { variant: 'base/escape' })), /safe path segment/);
  });
});
