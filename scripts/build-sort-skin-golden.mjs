#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalize,
  compileRecipeProposal,
  generate,
  validateLevelSpec,
} from '../recipes/sort/levels/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'recipes', 'sort', 'skins', 'fixtures', 'skin-qa-archetypes.v1.json');
const canonicalLevelFixture = JSON.parse(readFileSync(path.resolve(
  here, '..', 'recipes', 'sort', 'levels', 'fixtures', 'sort-contract-golden.v1.json',
), 'utf8'));
const definitions = Object.freeze([
  { id: 'minimal', seed: 101, difficultyTarget: 'easy', params: { gridCols: 6, gridRows: 5, colorsUsed: 3, targetRectsTotal: 4, convSpeedMul: 0.8 } },
  { id: 'dense-grid', seed: 202, difficultyTarget: 'hard', params: { gridCols: 8, gridRows: 7, colorsUsed: 6, targetRectsTotal: 8, convSpeedMul: 1 } },
  { id: 'all-six-colors', seed: 137, difficultyTarget: 'hard', params: { gridCols: 8, gridRows: 7, colorsUsed: 6, targetRectsTotal: 8, convSpeedMul: 1 } },
  { id: 'max-conveyor-speed', seed: 202, difficultyTarget: 'hard', params: { gridCols: 8, gridRows: 7, colorsUsed: 6, targetRectsTotal: 8, convSpeedMul: 1.25 } },
  { id: 'mixed-baseline', fixture: 'baseline-medium-seed-137' },
]);

export function buildSortSkinArchetypes() {
  return {
    schema: 'sort.skin-qa-archetypes.v1',
    archetypes: definitions.map((definition) => {
      if (definition.fixture) {
        const selected = canonicalLevelFixture.levelSpecs.find(({ name }) => name === definition.fixture);
        if (!selected || !validateLevelSpec(selected.spec).ok) throw new Error(`invalid canonical skin archetype ${definition.id}`);
        return {
          id: definition.id,
          fixture: definition.fixture,
          recipeDigest: canonicalLevelFixture.recipe.version.recipeDigest,
          spec: selected.spec,
        };
      }
      const proposal = {
        schema: 'sort.recipe-proposal.v1',
        params: { ...definition.params, modifiers: [] },
      };
      const recipe = compileRecipeProposal(proposal);
      const spec = generate(recipe, definition.seed, definition.difficultyTarget);
      const checked = validateLevelSpec(spec);
      if (!checked.ok) throw new Error(`invalid generated skin archetype ${definition.id}`);
      return { ...definition, recipeDigest: recipe.recipeDigest, spec };
    }),
  };
}

const expected = `${JSON.stringify(buildSortSkinArchetypes(), null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(target, expected);
} else {
  const actual = readFileSync(target, 'utf8');
  if (canonicalize(JSON.parse(actual)) !== canonicalize(JSON.parse(expected))) {
    throw new Error('pinned Sort skin QA archetypes drifted; inspect before --write');
  }
}
console.log(JSON.stringify({ file: target, archetypes: definitions.map(({ id }) => id) }));
