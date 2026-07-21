import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  artProviderPolicy,
  artProviderPolicyDigest,
  artSourcePackSchema,
  artTemplateContract,
  artTemplateContractDigest,
  assertProvidedCharacters,
  computeArtPackHash,
  sha256Bytes,
  validateArtSourcePack,
} from '../recipes/merge/art-v1/contract.mjs';

const clone = (value) => structuredClone(value);

function png(width, height) {
  const bytes = Buffer.alloc(128);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fixture(root) {
  const sources = {};
  for (const [slot, expected] of Object.entries(artTemplateContract.generatedSources)) {
    const width = expected.kind === 'progression-sheet'
      ? expected.columns * expected.minimumCellSize : expected.minimumWidth;
    const height = expected.kind === 'progression-sheet'
      ? Math.max(256, expected.rows * expected.minimumCellSize) : expected.minimumHeight;
    const bytes = png(width, height);
    const rel = `generated/${slot}.png`;
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), bytes);
    sources[slot] = {
      path: rel,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      width,
      height,
      promptDigest: 'a'.repeat(64),
    };
  }
  const value = {
    schema: 'merge.art-source-pack.v1',
    artPackHash: '',
    templateContractDigest: artTemplateContractDigest,
    providerPolicyDigest: artProviderPolicyDigest,
    world: {
      worldId: 'golden-world',
      title: 'Golden World',
      visualThesis: 'A deliberately synthetic world used only for contract replay.',
      palette: ['#112233', '#445566', '#778899', '#AABBCC'],
      promptProfile: 'Rounded premium mobile-game art, isolated subjects, no text or logos.',
    },
    budgetReceipt: { provider: 'openai.builtin-imagegen.v1', calls: 9, marginalCostMicros: 0, priceKnown: true },
    sources,
  };
  value.artPackHash = computeArtPackHash(value);
  return value;
}

test('template and provider policy freeze the first Merge raster vertical', () => {
  assert.equal(artTemplateContract.schema, 'merge.art-template.v1');
  assert.equal(artTemplateContract.mechanicId, 'merge-locked-v1-swipe');
  assert.equal(artTemplateContract.source.commit, '231ec0432f77b4d1b9b842ff6ed0528e00bf89fd');
  assert.equal(artTemplateContract.source.tree, '6fcc34863aba38379e8565bd876a20980a5eadbc');
  assert.equal(artTemplateContract.source.playableTree, '6a74c48ae21a0d50ffac31cfef45cd6c9ce8dec9');
  assert.equal(artTemplateContract.runtime.characterMode, 'provided-static-rgba');
  assert.match(artTemplateContract.source.buildStamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(artTemplateContract.runtime.forbiddenModules, ['spine-player', 'spine-assets', 'spine-webgl-3.7']);
  assert.deepEqual(Object.values(artTemplateContract.generatedSources).filter((item) => item.kind === 'progression-sheet').map((item) => item.count), [7, 4, 3, 3]);
  assert.equal(artProviderPolicy.provider, 'openai.builtin-imagegen.v1');
  assert.equal(artProviderPolicy.limits.maximumCallsPerWorld, 9);
  assert.equal(artProviderPolicy.billing.maximumMarginalCostMicrosPerWorld, 0);
  assert.equal(artProviderPolicy.billing.unknownPriceBehavior, 'deny');
  assert.match(artTemplateContractDigest, /^[0-9a-f]{64}$/);
  assert.match(artProviderPolicyDigest, /^[0-9a-f]{64}$/);
});

test('provided static character bytes and dimensions match the frozen template', () => {
  const checked = assertProvidedCharacters();
  assert.equal(checked.length, 3);
  assert.deepEqual(checked.map((item) => item.slot), ['order-1', 'order-2', 'order-3']);
  assert.ok(checked.every((item) => item.bytes > 100_000));
});

test('source pack uses exact keys, JCS identity, budget and on-disk byte closure', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-art-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const value = fixture(root);
  assert.deepEqual(validateArtSourcePack(value, { packRoot: root, verifyFiles: true }), { ok: true, errors: [] });
  assert.equal(computeArtPackHash(value), value.artPackHash);

  const changed = clone(value);
  changed.world.title = 'Different identity';
  assert.deepEqual(validateArtSourcePack(changed).errors.map((item) => item.code), ['art_pack_hash_mismatch']);

  const injected = clone(value);
  injected.sources.chain1Sheet.executable = 'alert(1)';
  assert.equal(validateArtSourcePack(injected).ok, false);
  assert.equal(artSourcePackSchema.additionalProperties, false);
});

test('source pack fails closed on budget, dimensions, traversal and byte tampering', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-art-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const value = fixture(root);

  const wrongBudget = clone(value);
  wrongBudget.budgetReceipt.calls = 8;
  wrongBudget.artPackHash = computeArtPackHash(wrongBudget);
  assert.ok(validateArtSourcePack(wrongBudget).errors.some((item) => item.code === 'budget_call_count_mismatch'));

  const tooSmall = clone(value);
  tooSmall.sources.generator.width = 256;
  tooSmall.artPackHash = computeArtPackHash(tooSmall);
  assert.ok(validateArtSourcePack(tooSmall).errors.some((item) => item.code === 'source_dimensions_too_small'));

  const traversal = clone(value);
  traversal.sources.generator.path = 'generated/../../secret.png';
  traversal.artPackHash = computeArtPackHash(traversal);
  assert.equal(validateArtSourcePack(traversal).ok, false);

  writeFileSync(path.join(root, value.sources.generator.path), png(513, 512));
  const codes = validateArtSourcePack(value, { packRoot: root, verifyFiles: true }).errors.map((item) => item.code);
  assert.ok(codes.includes('source_digest_mismatch'));
  assert.ok(codes.includes('source_dimensions_mismatch'));
});
