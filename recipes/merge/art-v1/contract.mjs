import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { canonicalize, sha256Jcs } from '../../sort/levels/jcs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const loadJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const artTemplateContract = deepFreeze(loadJson('merge.art-template.v1.json'));
export const artTemplateContractDigest = sha256Jcs(artTemplateContract);
export const artProviderPolicy = deepFreeze(loadJson('merge.art-provider-policy.v1.json'));
export const artProviderPolicyDigest = sha256Jcs(artProviderPolicy);
export const artSourcePackSchema = deepFreeze(loadJson('merge.art-source-pack.v1.schema.json'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(artSourcePackSchema);

function schemaErrors(errors = []) {
  return errors.map((error) => ({
    code: `schema.${error.keyword}`,
    path: error.instancePath || '/',
    message: error.message || 'JSON Schema validation failed',
  }));
}

export function sourcePackIdentity(pack) {
  return {
    schema: pack.schema,
    templateContractDigest: pack.templateContractDigest,
    providerPolicyDigest: pack.providerPolicyDigest,
    world: pack.world,
    budgetReceipt: pack.budgetReceipt,
    sources: pack.sources,
  };
}

export function computeArtPackHash(pack) {
  return sha256Jcs(sourcePackIdentity(pack));
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readPngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24
    || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new TypeError('asset must be a PNG with an IHDR header');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function safeAssetPath(root, value) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, String(value || ''));
  if (!absolute.startsWith(`${absoluteRoot}${sep}`)) throw new TypeError('asset path escapes pack root');
  return absolute;
}

export function validateArtSourcePack(value, { packRoot = null, verifyFiles = false } = {}) {
  const valid = validateSchema(value);
  const errors = valid ? [] : schemaErrors(validateSchema.errors);
  if (!valid) return { ok: false, errors };

  if (value.templateContractDigest !== artTemplateContractDigest) {
    errors.push({ code: 'template_contract_mismatch', path: '/templateContractDigest', message: 'templateContractDigest does not match merge.art-template.v1' });
  }
  if (value.providerPolicyDigest !== artProviderPolicyDigest) {
    errors.push({ code: 'provider_policy_mismatch', path: '/providerPolicyDigest', message: 'providerPolicyDigest does not match merge.art-provider-policy.v1' });
  }
  if (value.artPackHash !== computeArtPackHash(value)) {
    errors.push({ code: 'art_pack_hash_mismatch', path: '/artPackHash', message: 'artPackHash must equal sha256(JCS(sourcePackIdentity))' });
  }
  if (value.budgetReceipt.calls !== Object.keys(value.sources).length) {
    errors.push({ code: 'budget_call_count_mismatch', path: '/budgetReceipt/calls', message: 'budget receipt calls must equal the exact generated source count' });
  }

  for (const [slot, expected] of Object.entries(artTemplateContract.generatedSources)) {
    const source = value.sources[slot];
    if (!source) continue;
    if (source.path.split('/').includes('..')) {
      errors.push({ code: 'source_path_escape', path: `/sources/${slot}/path`, message: `${slot} path contains a traversal segment` });
    }
    if (source.width < expected.minimumWidth || source.height < expected.minimumHeight) {
      errors.push({ code: 'source_dimensions_too_small', path: `/sources/${slot}`, message: `${slot} is smaller than its frozen minimum` });
    }
    if (expected.kind === 'progression-sheet') {
      if (Math.floor(source.width / expected.columns) < expected.minimumCellSize
        || Math.floor(source.height / expected.rows) < expected.minimumCellSize) {
        errors.push({ code: 'progression_cell_too_small', path: `/sources/${slot}`, message: `${slot} cells are smaller than the frozen minimum` });
      }
    }
  }

  if (verifyFiles) {
    if (!packRoot) throw new TypeError('packRoot is required when verifyFiles=true');
    for (const [slot, source] of Object.entries(value.sources)) {
      try {
        const file = safeAssetPath(packRoot, source.path);
        const bytes = readFileSync(file);
        const actual = statSync(file);
        const dimensions = readPngDimensions(bytes);
        if (actual.size !== source.bytes) errors.push({ code: 'source_bytes_mismatch', path: `/sources/${slot}/bytes`, message: `${slot} byte size does not match disk` });
        if (sha256Bytes(bytes) !== source.sha256) errors.push({ code: 'source_digest_mismatch', path: `/sources/${slot}/sha256`, message: `${slot} digest does not match disk` });
        if (dimensions.width !== source.width || dimensions.height !== source.height) errors.push({ code: 'source_dimensions_mismatch', path: `/sources/${slot}`, message: `${slot} dimensions do not match IHDR` });
        if (relative(resolve(packRoot), file).startsWith('..')) errors.push({ code: 'source_path_escape', path: `/sources/${slot}/path`, message: `${slot} escapes pack root` });
      } catch (error) {
        errors.push({ code: 'source_file_invalid', path: `/sources/${slot}`, message: `${slot}: ${error.message}` });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export class MergeArtContractError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'MergeArtContractError';
    this.errors = errors;
  }
}

export function assertArtSourcePack(value, options) {
  const checked = validateArtSourcePack(value, options);
  if (!checked.ok) throw new MergeArtContractError('invalid Merge Art Source Pack', checked.errors);
  return value;
}

export function assertProvidedCharacters(root = here) {
  return artTemplateContract.providedCharacters.map((asset) => {
    const file = safeAssetPath(root, asset.path);
    const bytes = readFileSync(file);
    const dimensions = readPngDimensions(bytes);
    if (sha256Bytes(bytes) !== asset.sha256 || dimensions.width !== asset.width || dimensions.height !== asset.height) {
      throw new MergeArtContractError(`provided character ${asset.slot} does not match the frozen contract`, []);
    }
    return { ...asset, bytes: bytes.length };
  });
}

export { canonicalize };
