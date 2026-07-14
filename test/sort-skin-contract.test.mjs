import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canonicalize,
  computeSkinHash,
  roleColorEvidence,
  simulateColorView,
  skinContract,
  skinContractDigest,
  skinSpecIdentity,
  skinSpecSchema,
  validateSkinSpec,
} from '../recipes/sort/skins/contract.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('../recipes/sort/skins/fixtures/sort-skin-contract-golden.v1.json', import.meta.url),
  'utf8',
));
const manualSkins = JSON.parse(readFileSync(
  new URL('../recipes/sort/skins/fixtures/manual-skins.v1.json', import.meta.url),
  'utf8',
));
const clone = (value) => structuredClone(value);
const codes = (checked) => checked.errors.map((error) => error.code);

test('literal SkinSpec contract, schema const, JCS identity and hash match golden', () => {
  assert.equal(skinContract.contract, 'sort.skin-contract.v1');
  assert.equal(skinContractDigest, fixture.skinContractDigest);
  assert.equal(skinSpecSchema.properties.skinContractDigest.const, skinContractDigest);
  assert.equal(canonicalize(skinSpecIdentity(fixture.validSpec)), fixture.identityCanonical);
  assert.equal(computeSkinHash(fixture.validSpec), fixture.validSpec.skinHash);
  assert.deepEqual(validateSkinSpec(fixture.validSpec), { ok: true, errors: [] });
});

test('normal and color-vision transforms are byte-exact golden vectors', () => {
  const colors = fixture.validSpec.params.roleDisplayColors;
  const evidence = roleColorEvidence(colors);
  for (const [view, expected] of Object.entries(fixture.colorViews)) {
    assert.deepEqual(colors.map((color) => simulateColorView(color, view)), expected.transformed);
    assert.equal(evidence[view].minimum, expected.minimum);
    assert.equal(evidence[view].required, expected.minimum);
    assert.equal(evidence[view].pairs.length, 15);
  }
});

test('SkinSpec is complete, alias-free and excludes gameplay or executable fields', () => {
  for (const field of [
    'marbleStyle', 'markerStyle', 'targetShape', 'sourceShape',
    'backgroundPattern', 'sceneColors', 'roleDisplayColors',
  ]) {
    const missing = clone(fixture.validSpec);
    delete missing.params[field];
    assert.equal(validateSkinSpec(missing).ok, false, field);
  }
  for (const field of ['difficulty', 'motion', 'conveyorPath', 'props', 'svg', 'assetId', 'script']) {
    const injected = clone(fixture.validSpec);
    injected.params[field] = field === 'script' ? 'return process.env' : 'forbidden';
    assert.equal(validateSkinSpec(injected).ok, false, field);
  }
  const lowercase = clone(fixture.validSpec);
  lowercase.params.sceneColors.ground = '#5b6b8a';
  assert.equal(validateSkinSpec(lowercase).ok, false);
});

test('all 15 role pairs must clear every frozen view threshold', () => {
  const tooClose = clone(fixture.validSpec);
  tooClose.params.roleDisplayColors[5] = tooClose.params.roleDisplayColors[1];
  tooClose.skinHash = computeSkinHash(tooClose);
  assert.deepEqual(codes(validateSkinSpec(tooClose)), [
    'role_colors_deuteranopia',
    'role_colors_normal',
    'role_colors_protanopia',
  ]);

  const malformed = clone(fixture.validSpec);
  malformed.params.roleDisplayColors.pop();
  assert.equal(validateSkinSpec(malformed).ok, false);
});

test('skinHash covers only schema, contract digest and complete params', () => {
  const changed = clone(fixture.validSpec);
  changed.params.markerStyle = 'glyphs';
  assert.deepEqual(codes(validateSkinSpec(changed)), ['skin_hash_mismatch']);
  changed.skinHash = computeSkinHash(changed);
  assert.deepEqual(validateSkinSpec(changed), { ok: true, errors: [] });

  const lineage = { ...fixture.validSpec, authoredBy: 'manual-v1' };
  assert.equal(computeSkinHash(lineage), fixture.validSpec.skinHash);
  assert.equal(validateSkinSpec(lineage).ok, false);
});

test('six manual directions are accessible and identity-distinct', () => {
  assert.equal(manualSkins.length, 6);
  assert.equal(new Set(manualSkins.map(({ id }) => id)).size, 6);
  assert.equal(new Set(manualSkins.map(({ spec }) => spec.skinHash)).size, 6);
  for (const { id, spec } of manualSkins) {
    assert.deepEqual(validateSkinSpec(spec), { ok: true, errors: [] }, id);
    assert.equal(computeSkinHash(spec), spec.skinHash, id);
  }
});
