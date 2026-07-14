import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { canonicalize, sha256Jcs } from '../levels/jcs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const loadJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export const skinContract = deepFreeze(loadJson('sort.skin-contract.v1.json'));
export const skinContractDigest = sha256Jcs(skinContract);
export const skinSpecSchema = deepFreeze(loadJson('sort.skin-spec.v1.schema.json'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemaValidator = ajv.compile(skinSpecSchema);

function schemaErrors(errors = []) {
  return errors.map((error) => ({
    code: `schema.${error.keyword}`,
    path: error.instancePath || '/',
    message: error.message || 'JSON Schema validation failed',
  }));
}

export function skinSpecIdentity(spec) {
  return {
    schema: spec.schema,
    skinContractDigest: spec.skinContractDigest,
    params: spec.params,
  };
}

export function computeSkinHash(spec) {
  return sha256Jcs(skinSpecIdentity(spec));
}

function decodeChannel(byte) {
  const channel = byte / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function encodeChannel(channel) {
  const clamped = Math.max(0, Math.min(1, channel));
  const encoded = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
  return Math.round(encoded * 255);
}

export function hexToRgb(hex) {
  if (typeof hex !== 'string' || !/^#[0-9A-F]{6}$/.test(hex)) {
    throw new TypeError('skin color must be uppercase #RRGGBB');
  }
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

export function simulateColorView(hex, view) {
  const definition = skinContract.colorValidation.views[view];
  if (!definition) throw new RangeError(`unknown skin color view: ${String(view)}`);
  const linear = hexToRgb(hex).map(decodeChannel);
  return definition.matrix.map((row) => encodeChannel(
    row.reduce((sum, coefficient, index) => sum + coefficient * linear[index], 0),
  ));
}

export function rgbManhattan(left, right) {
  return left.reduce((sum, channel, index) => sum + Math.abs(channel - right[index]), 0);
}

export function roleColorEvidence(colors) {
  const evidence = {};
  for (const [view, definition] of Object.entries(skinContract.colorValidation.views)) {
    const transformed = colors.map((color) => simulateColorView(color, view));
    const pairs = [];
    for (let left = 0; left < transformed.length; left += 1) {
      for (let right = left + 1; right < transformed.length; right += 1) {
        pairs.push({
          left,
          right,
          distance: rgbManhattan(transformed[left], transformed[right]),
        });
      }
    }
    evidence[view] = {
      transformed,
      minimum: Math.min(...pairs.map((pair) => pair.distance)),
      required: definition.minPairwiseDistance,
      pairs,
    };
  }
  return evidence;
}

export function validateSkinSpec(value) {
  const valid = schemaValidator(value);
  const errors = valid ? [] : schemaErrors(schemaValidator.errors);
  if (!valid) return { ok: false, errors };

  if (value.skinContractDigest !== skinContractDigest) {
    errors.push({
      code: 'skin_contract_mismatch',
      path: '/skinContractDigest',
      message: 'skinContractDigest does not match the literal sort.skin-contract.v1 object',
    });
  }
  if (value.skinHash !== computeSkinHash(value)) {
    errors.push({
      code: 'skin_hash_mismatch',
      path: '/skinHash',
      message: 'skinHash must equal sha256(JCS({schema,skinContractDigest,params}))',
    });
  }

  const evidence = roleColorEvidence(value.params.roleDisplayColors);
  for (const [view, item] of Object.entries(evidence)) {
    if (item.minimum < item.required) {
      errors.push({
        code: `role_colors_${view}`,
        path: '/params/roleDisplayColors',
        message: `${view} minimum distance ${item.minimum} is below ${item.required}`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

export class SortSkinContractError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'SortSkinContractError';
    this.errors = errors;
  }
}

export function assertSkinSpec(value) {
  const checked = validateSkinSpec(value);
  if (!checked.ok) throw new SortSkinContractError('invalid Sort SkinSpec', checked.errors);
  return value;
}

export { canonicalize };
