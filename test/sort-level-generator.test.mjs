import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DIFFICULTY_TARGETS,
  canonicalize,
  compileRecipeProposal,
  computeLevelSpecHash,
  deriveSubstreamSeed,
  generate,
  mulberry32,
  runtimeContract,
  validateLevelSpec,
} from '../recipes/sort/levels/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(
  join(here, '../recipes/sort/levels/fixtures/sort-contract-golden.v1.json'),
  'utf8',
));

function compile(params = {}) {
  return compileRecipeProposal({ schema: 'sort.recipe-proposal.v1', params });
}

function assertGeneratedInvariants(spec, recipe) {
  assert.deepEqual(validateLevelSpec(spec), { ok: true, errors: [] });
  assert.equal(spec.specHash, computeLevelSpecHash(spec));
  assert.equal(spec.params.cellColorMap.length, recipe.params.gridCols * recipe.params.gridRows);
  assert.equal(spec.params.targetStacks.flat().length, recipe.params.targetRectsTotal);
  assert.equal(Object.hasOwn(spec.params, 'targetRectsTotal'), false);
  assert.equal(Object.hasOwn(spec, 'difficultyTarget'), false);
  assert.equal(Object.hasOwn(spec, 'recipeDigest'), false);

  const lengths = spec.params.targetStacks.map((stack) => stack.length);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1);
  const available = Array(recipe.params.colorsUsed).fill(0);
  for (const color of spec.params.cellColorMap) available[color] += runtimeContract.marblesPerCell;
  const demand = Array(recipe.params.colorsUsed).fill(0);
  for (const color of spec.params.targetStacks.flat()) demand[color] += runtimeContract.rectCapacity;
  for (let color = 0; color < recipe.params.colorsUsed; color += 1) {
    assert.ok(demand[color] <= available[color], `resource balance for color ${color}`);
  }
}

test('mulberry32 layout stream and generated LevelSpec match the golden vector', () => {
  const golden = fixture.generation;
  assert.equal(deriveSubstreamSeed(golden.seed, 'layout'), golden.layoutSeed);
  const random = mulberry32(golden.layoutSeed);
  assert.deepEqual(
    golden.mulberry32Uint32.map(() => Math.floor(random() * 4294967296)),
    golden.mulberry32Uint32,
  );

  const generated = generate(compile(), golden.seed, golden.difficultyTarget);
  assert.deepEqual(generated, golden.spec);
  assert.equal(canonicalize(generate(compile(), golden.seed, golden.difficultyTarget)), canonicalize(generated));
  assertGeneratedInvariants(generated, compile());
});

test('generate is immutable, deterministic, and difficultyTarget selects distinct layout mixing', () => {
  const recipe = compile({
    gridCols: 7,
    gridRows: 6,
    colorsUsed: 5,
    targetRectsTotal: 17,
    convSpeedMul: 1.25,
  });
  const specs = DIFFICULTY_TARGETS.map((difficulty) => generate(recipe, 0xdeadbeef, difficulty));
  assert.equal(new Set(specs.map((spec) => spec.specHash)).size, DIFFICULTY_TARGETS.length);
  for (let index = 0; index < specs.length; index += 1) {
    const difficulty = DIFFICULTY_TARGETS[index];
    const repeated = generate(recipe, 0xdeadbeef, difficulty);
    assert.deepEqual(repeated, specs[index]);
    assert.equal(canonicalize(repeated), canonicalize(specs[index]));
    assertGeneratedInvariants(repeated, recipe);
    assert.equal(Object.isFrozen(repeated), true);
    assert.equal(Object.isFrozen(repeated.params), true);
    assert.equal(Object.isFrozen(repeated.params.cellColorMap), true);
    assert.equal(Object.isFrozen(repeated.params.targetStacks[0]), true);
  }
});

test('generate covers every recipe axis boundary, target total, difficulty, and uint32 edge seed', () => {
  const speeds = [0.8, 1, 1.25];
  const edgeSeeds = [0, 1, 137, 0x7fffffff, 0xffffffff];
  for (let index = 0; index < 256; index += 1) {
    const recipe = compile({
      gridCols: 6 + (index % 3),
      gridRows: 5 + (Math.floor(index / 3) % 3),
      colorsUsed: 3 + (Math.floor(index / 9) % 4),
      targetRectsTotal: 4 + ((index * 5) % 21),
      convSpeedMul: speeds[index % speeds.length],
    });
    const difficulty = DIFFICULTY_TARGETS[index % DIFFICULTY_TARGETS.length];
    const seed = index < edgeSeeds.length
      ? edgeSeeds[index]
      : (Math.imul(index + 1, 0x9e3779b1) >>> 0);
    const generated = generate(recipe, seed, difficulty);
    assertGeneratedInvariants(generated, recipe);
    assert.deepEqual(generate(recipe, seed, difficulty), generated);
  }

  for (let total = 4; total <= 24; total += 1) {
    const recipe = compile({ targetRectsTotal: total });
    for (const difficulty of DIFFICULTY_TARGETS) {
      const generated = generate(recipe, total * 1009, difficulty);
      assertGeneratedInvariants(generated, recipe);
    }
  }
});

test('generate fails closed for invalid recipes, seeds, and difficulty targets', () => {
  const recipe = compile();
  const tampered = structuredClone(recipe);
  tampered.recipeDigest = '0'.repeat(64);
  assert.throws(() => generate(tampered, 1, 'easy'), /invalid Sort RecipeVersion/);
  assert.throws(
    () => generate({ schema: 'sort.recipe-proposal.v1', params: {} }, 1, 'easy'),
    /invalid Sort RecipeVersion/,
  );

  for (const seed of [-1, 0x100000000, 1.5, Number.NaN, '1']) {
    assert.throws(() => generate(recipe, seed, 'easy'), /invalid Sort level generation input/);
  }
  for (const difficulty of ['', 'normal', 'HARD', null]) {
    assert.throws(() => generate(recipe, 1, difficulty), /invalid Sort level generation input/);
  }
});
