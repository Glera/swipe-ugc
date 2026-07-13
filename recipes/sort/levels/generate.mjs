import {
  SortContractError,
  assertLevelSpec,
  computeLevelSpecHash,
  runtimeContractDigest,
  validateRecipeVersion,
} from './contract.mjs';
import { rngFor, shuffleInPlace } from './rng.mjs';

export const DIFFICULTY_TARGETS = Object.freeze(['easy', 'medium', 'hard', 'expert']);

function generationError(code, path, message) {
  return new SortContractError('invalid Sort level generation input', [{ code, path, message }]);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function balancedColors(length, colorOrder) {
  return Array.from({ length }, (_, index) => colorOrder[index % colorOrder.length]);
}

function shufflePasses(values, random, passes) {
  for (let pass = 0; pass < passes; pass += 1) shuffleInPlace(values, random);
  return values;
}

function splitTargetStacks(targetColors) {
  const baseLength = Math.floor(targetColors.length / 4);
  const extraColumns = targetColors.length % 4;
  let cursor = 0;
  return Array.from({ length: 4 }, (_, column) => {
    const length = baseLength + (column < extraColumns ? 1 : 0);
    const stack = targetColors.slice(cursor, cursor + length);
    cursor += length;
    return stack;
  });
}

/**
 * Pure local generator. Difficulty changes deterministic layout mixing only;
 * measured difficulty and publishability still belong to the oracle/QA gate.
 */
export function generate(recipeVersion, seed, difficultyTarget) {
  const checkedRecipe = validateRecipeVersion(recipeVersion);
  if (!checkedRecipe.ok) throw new SortContractError('invalid Sort RecipeVersion', checkedRecipe.errors);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw generationError('seed', '/seed', 'seed must be an unsigned 32-bit integer');
  }
  const difficultyRank = DIFFICULTY_TARGETS.indexOf(difficultyTarget);
  if (difficultyRank < 0) {
    throw generationError(
      'difficulty_target',
      '/difficultyTarget',
      `difficultyTarget must be one of ${DIFFICULTY_TARGETS.join('/')}`,
    );
  }

  const {
    gridCols,
    gridRows,
    colorsUsed,
    targetRectsTotal,
    convSpeedMul,
    modifiers,
  } = recipeVersion.params;
  const random = rngFor(seed, 'layout');

  // Both pools begin balanced by construction. Shuffling changes topology but
  // never per-colour resource counts, so resource-balance cannot drift by seed.
  const colorOrder = shuffleInPlace(Array.from({ length: colorsUsed }, (_, index) => index), random);
  const cellColorMap = balancedColors(gridCols * gridRows, colorOrder);
  shufflePasses(cellColorMap, random, difficultyRank + 1);

  const targetColorOrder = colorOrder.slice(difficultyRank).concat(colorOrder.slice(0, difficultyRank));
  const targetColors = balancedColors(targetRectsTotal, targetColorOrder);
  shufflePasses(targetColors, random, difficultyRank);
  const targetStacks = splitTargetStacks(targetColors);

  const spec = {
    schema: 'sort.level-spec.v1',
    specHash: '',
    runtimeContractDigest,
    seed,
    params: {
      gridCols,
      gridRows,
      colorsUsed,
      cellColorMap,
      targetStacks,
      convSpeedMul,
      modifiers: [...modifiers],
    },
  };
  spec.specHash = computeLevelSpecHash(spec);
  assertLevelSpec(spec);
  return deepFreeze(spec);
}
