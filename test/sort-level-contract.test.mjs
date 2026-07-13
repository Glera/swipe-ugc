import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileRecipeProposal,
  computeLevelSpecHash,
  levelSpecSchema,
  recipeProposalSchema,
  recipeVersionSchema,
  runtimeContract,
  runtimeContractDigest,
  validateLevelSpec,
  validateRecipeProposal,
  validateRecipeVersion,
} from '../recipes/sort/levels/contract.mjs';
import {
  canonicalize,
  deriveSubstreamSeed,
  levelSpecIdentity,
} from '../recipes/sort/levels/jcs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(
  join(here, '../recipes/sort/levels/fixtures/sort-contract-golden.v1.json'),
  'utf8',
));
const backendIdentityFixturePath = join(here, '../../swipe-backend/tests/fixtures/content-identity-vectors.json');
const goldenSpec = fixture.levelSpecs[0].spec;

function clone(value) {
  return structuredClone(value);
}

function codes(checked) {
  return checked.errors.map((error) => error.code);
}

test('literal runtime contract, JCS bytes, digest, and FNV substreams match golden vectors', () => {
  assert.equal(runtimeContract.contract, 'sort.runtime-contract.v1');
  assert.deepEqual(runtimeContract.palette, [
    '#5BC8D8', '#F5C842', '#FF7B7B', '#7BE87B', '#B07BFF', '#FF9F43',
  ]);
  assert.equal(runtimeContract.rectCapacity, 3);
  assert.equal(runtimeContract.marblesPerCell, 9);
  assert.equal(canonicalize(runtimeContract), fixture.runtimeContract.canonical);
  assert.equal(runtimeContractDigest, fixture.runtimeContract.sha256);
  assert.equal(levelSpecSchema.properties.runtimeContractDigest.const, runtimeContractDigest);

  for (const vector of fixture.substreamSeeds) {
    assert.equal(deriveSubstreamSeed(vector.seed, 'layout'), vector.layout);
    assert.equal(deriveSubstreamSeed(vector.seed, 'gameplay'), vector.gameplay);
    assert.equal(deriveSubstreamSeed(vector.seed, 'visual'), vector.visual);
  }
});

test('canonical contract stays synchronized with the backend identity fixture when both repos are present', (context) => {
  if (!existsSync(backendIdentityFixturePath)) {
    context.skip('sibling swipe-backend checkout is not present');
    return;
  }
  const shared = JSON.parse(readFileSync(backendIdentityFixturePath, 'utf8'));
  assert.deepEqual(shared.runtimeContract.value, runtimeContract);
  assert.equal(shared.runtimeContract.canonical, fixture.runtimeContract.canonical);
  assert.equal(shared.runtimeContract.sha256, runtimeContractDigest);
  for (const vector of shared.canonicalization) {
    assert.equal(canonicalize(vector.value), vector.canonical, vector.name);
  }

  const source = shared.levelSpec.value;
  const storedSpec = {
    schema: source.schema,
    specHash: shared.levelSpec.specHash,
    runtimeContractDigest: source.runtimeContractDigest,
    seed: source.seed,
    params: source.params,
  };
  assert.deepEqual(validateLevelSpec(storedSpec), { ok: true, errors: [] });
  assert.equal(canonicalize(levelSpecIdentity(storedSpec)), shared.levelSpec.canonical);
});

test('JCS rejects non-JSON values and canonicalizes by UTF-16 property order', () => {
  assert.equal(canonicalize({ z: 1, a: -0, nested: { b: true, a: null } }), '{"a":0,"nested":{"a":null,"b":true},"z":1}');
  assert.throws(() => canonicalize(Number.NaN), /finite JSON numbers/);
  assert.throws(() => canonicalize({ value: undefined }), /cannot encode property value/);
  assert.throws(() => canonicalize('\ud800'), /unpaired Unicode surrogate/);
});

test('RecipeProposal defaults compile once into a complete immutable RecipeVersion', () => {
  assert.deepEqual(validateRecipeProposal(fixture.recipe.proposal), { ok: true, errors: [] });
  const compiled = compileRecipeProposal(fixture.recipe.proposal);
  assert.deepEqual(compiled, fixture.recipe.version);
  assert.deepEqual(validateRecipeVersion(compiled), { ok: true, errors: [] });
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.params), true);
  assert.match(JSON.stringify(recipeProposalSchema), /"default"/);
  assert.doesNotMatch(JSON.stringify(recipeVersionSchema), /"default"/);
  assert.doesNotMatch(JSON.stringify(levelSpecSchema), /"default"/);
});

test('model-authored recipe input rejects unknown, executable, non-finite, and out-of-range fields', () => {
  const cases = [
    { schema: 'sort.recipe-proposal.v1', params: { url: 'https://example.invalid/recipe.js' } },
    { schema: 'sort.recipe-proposal.v1', params: { script: 'return process.env' } },
    { schema: 'sort.recipe-proposal.v1', params: { gridCols: Number.NaN } },
    { schema: 'sort.recipe-proposal.v1', params: { colorsUsed: 7 } },
    { schema: 'sort.recipe-proposal.v1', params: { modifiers: ['unknown'] } },
    { schema: 'sort.recipe-proposal.v1', params: {}, extra: true },
  ];
  for (const candidate of cases) {
    assert.equal(validateRecipeProposal(candidate).ok, false, JSON.stringify(candidate));
    assert.throws(() => compileRecipeProposal(candidate), /invalid Sort RecipeProposal/);
  }

  const missingMaterializedField = clone(fixture.recipe.version);
  delete missingMaterializedField.params.gridCols;
  assert.equal(validateRecipeVersion(missingMaterializedField).ok, false);
  const wrongDigest = clone(fixture.recipe.version);
  wrongDigest.recipeDigest = '0'.repeat(64);
  assert.deepEqual(codes(validateRecipeVersion(wrongDigest)), ['recipe_digest_mismatch']);
});

test('golden LevelSpec validates and hashes exactly the four frozen identity fields', () => {
  assert.deepEqual(validateLevelSpec(goldenSpec), { ok: true, errors: [] });
  assert.equal(canonicalize(levelSpecIdentity(goldenSpec)), fixture.levelSpecs[0].identityCanonical);
  assert.equal(computeLevelSpecHash(goldenSpec), goldenSpec.specHash);

  const withLineage = {
    ...goldenSpec,
    generatorDigest: 'not-part-of-the-level-spec',
  };
  assert.equal(validateLevelSpec(withLineage).ok, false);
  assert.equal(computeLevelSpecHash(withLineage), goldenSpec.specHash);
});

test('LevelSpec schema executes every grid size, color bound, and balanced target total', () => {
  for (let cols = 6; cols <= 8; cols += 1) {
    for (let rows = 5; rows <= 7; rows += 1) {
      for (let colors = 3; colors <= 6; colors += 1) {
        const candidate = clone(goldenSpec);
        candidate.params.gridCols = cols;
        candidate.params.gridRows = rows;
        candidate.params.colorsUsed = colors;
        candidate.params.cellColorMap = Array.from({ length: cols * rows }, (_, index) => index % colors);
        candidate.params.targetStacks = Array.from({ length: 4 }, (_, stack) => [stack % colors]);
        candidate.specHash = computeLevelSpecHash(candidate);
        assert.deepEqual(validateLevelSpec(candidate), { ok: true, errors: [] }, `${cols}x${rows}/${colors}`);
      }
    }
  }

  for (let targetTotal = 4; targetTotal <= 24; targetTotal += 1) {
    const candidate = clone(goldenSpec);
    const base = Math.floor(targetTotal / 4);
    const remainder = targetTotal % 4;
    candidate.params.targetStacks = Array.from({ length: 4 }, (_, stack) => (
      Array.from({ length: base + (stack < remainder ? 1 : 0) }, (_, index) => (stack + index) % 6)
    ));
    candidate.specHash = computeLevelSpecHash(candidate);
    assert.deepEqual(validateLevelSpec(candidate), { ok: true, errors: [] }, `target total ${targetTotal}`);
  }
});

test('LevelSpec rejects structural drift, dynamic bounds, bad hashes, and resource imbalance', () => {
  const wrongMapLength = clone(goldenSpec);
  wrongMapLength.params.cellColorMap.pop();
  assert.ok(codes(validateLevelSpec(wrongMapLength)).includes('schema.minItems'));

  const relativeColorOverflow = clone(goldenSpec);
  relativeColorOverflow.params.colorsUsed = 3;
  assert.ok(codes(validateLevelSpec(relativeColorOverflow)).includes('schema.maximum'));

  const unbalancedStacks = clone(goldenSpec);
  unbalancedStacks.params.targetStacks = [[0], [1], [2], [3, 4, 5]];
  assert.equal(validateLevelSpec(unbalancedStacks).ok, false);

  const nonEmptyModifiers = clone(goldenSpec);
  nonEmptyModifiers.params.modifiers = ['future-rule'];
  assert.equal(validateLevelSpec(nonEmptyModifiers).ok, false);

  const badHash = clone(goldenSpec);
  badHash.seed += 1;
  assert.deepEqual(codes(validateLevelSpec(badHash)), ['spec_hash_mismatch']);

  const resourceStarved = clone(goldenSpec);
  resourceStarved.params.cellColorMap.fill(0);
  resourceStarved.params.targetStacks = [[5, 5], [5, 5], [5, 5], [5, 5]];
  resourceStarved.specHash = computeLevelSpecHash(resourceStarved);
  assert.deepEqual(codes(validateLevelSpec(resourceStarved)), ['resource_balance']);
});
