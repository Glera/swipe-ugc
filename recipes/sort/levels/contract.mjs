import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  levelSpecIdentity,
  recipeVersionIdentity,
  sha256Jcs,
} from './jcs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const loadJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export const runtimeContract = deepFreeze(loadJson('sort.runtime-contract.v1.json'));
export const runtimeContractDigest = sha256Jcs(runtimeContract);
export const levelSpecSchema = deepFreeze(loadJson('sort.level-spec.v1.schema.json'));
export const recipeProposalSchema = deepFreeze(loadJson('RecipeProposal.schema.json'));
export const recipeVersionSchema = deepFreeze(loadJson('RecipeVersion.schema.json'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const proposalAjv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
const levelSchemaValidator = ajv.compile(levelSpecSchema);
const recipeProposalSchemaValidator = ajv.compile(recipeProposalSchema);
const recipeProposalDefaultingValidator = proposalAjv.compile(recipeProposalSchema);
const recipeVersionSchemaValidator = ajv.compile(recipeVersionSchema);

function schemaErrors(errors = []) {
  return errors.map((error) => ({
    code: `schema.${error.keyword}`,
    path: error.instancePath || '/',
    message: error.message || 'JSON Schema validation failed',
  }));
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

export class SortContractError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'SortContractError';
    this.errors = errors;
  }
}

export function computeLevelSpecHash(spec) {
  return sha256Jcs(levelSpecIdentity(spec));
}

export function computeRecipeDigest(version) {
  return sha256Jcs(recipeVersionIdentity(version));
}

export function validateRecipeProposal(value) {
  const valid = recipeProposalSchemaValidator(value);
  return result(valid ? [] : schemaErrors(recipeProposalSchemaValidator.errors));
}

export function validateRecipeVersion(value) {
  const valid = recipeVersionSchemaValidator(value);
  const errors = valid ? [] : schemaErrors(recipeVersionSchemaValidator.errors);
  if (valid && value.recipeDigest !== computeRecipeDigest(value)) {
    errors.push({
      code: 'recipe_digest_mismatch',
      path: '/recipeDigest',
      message: 'recipeDigest must equal sha256(JCS({schema,params}))',
    });
  }
  return result(errors);
}

export function compileRecipeProposal(raw) {
  const checked = validateRecipeProposal(raw);
  if (!checked.ok) throw new SortContractError('invalid Sort RecipeProposal', checked.errors);

  const materialized = structuredClone(raw);
  if (!recipeProposalDefaultingValidator(materialized)) {
    throw new SortContractError('could not materialize Sort RecipeProposal', schemaErrors(recipeProposalDefaultingValidator.errors));
  }
  const version = {
    schema: 'sort.recipe-version.v1',
    recipeDigest: '',
    params: materialized.params,
  };
  version.recipeDigest = computeRecipeDigest(version);
  const checkedVersion = validateRecipeVersion(version);
  if (!checkedVersion.ok) throw new SortContractError('compiled an invalid Sort RecipeVersion', checkedVersion.errors);
  return deepFreeze(version);
}

export function validateLevelSpec(value) {
  const valid = levelSchemaValidator(value);
  const errors = valid ? [] : schemaErrors(levelSchemaValidator.errors);
  if (!valid) return result(errors);

  if (value.runtimeContractDigest !== runtimeContractDigest) {
    errors.push({
      code: 'runtime_contract_mismatch',
      path: '/runtimeContractDigest',
      message: 'runtimeContractDigest does not match the literal sort.runtime-contract.v1 object',
    });
  }

  const available = Array(value.params.colorsUsed).fill(0);
  for (const color of value.params.cellColorMap) available[color] += runtimeContract.marblesPerCell;
  const demand = Array(value.params.colorsUsed).fill(0);
  for (const stack of value.params.targetStacks) {
    for (const color of stack) demand[color] += runtimeContract.rectCapacity;
  }
  for (let color = 0; color < value.params.colorsUsed; color += 1) {
    if (demand[color] > available[color]) {
      errors.push({
        code: 'resource_balance',
        path: '/params/targetStacks',
        message: `color ${color} demands ${demand[color]} marbles but cellColorMap provides ${available[color]}`,
      });
    }
  }

  if (value.specHash !== computeLevelSpecHash(value)) {
    errors.push({
      code: 'spec_hash_mismatch',
      path: '/specHash',
      message: 'specHash must equal sha256(JCS({schema,runtimeContractDigest,seed,params}))',
    });
  }
  return result(errors);
}

export function assertLevelSpec(value) {
  const checked = validateLevelSpec(value);
  if (!checked.ok) throw new SortContractError('invalid Sort LevelSpec', checked.errors);
  return value;
}
