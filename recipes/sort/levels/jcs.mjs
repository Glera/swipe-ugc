import { createHash } from 'node:crypto';

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('JCS input contains an unpaired Unicode surrogate');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('JCS input contains an unpaired Unicode surrogate');
    }
  }
}

/** RFC 8785 JSON Canonicalization Scheme for ordinary parsed JSON values. */
export function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS only accepts finite JSON numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JCS only accepts plain JSON objects');
    return `{${Object.keys(value).sort().map((key) => {
      assertUnicode(key);
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new TypeError(`JCS cannot encode property ${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(item)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`JCS cannot encode ${typeof value}`);
}

export function sha256Jcs(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function levelSpecIdentity(spec) {
  return {
    schema: spec.schema,
    runtimeContractDigest: spec.runtimeContractDigest,
    seed: spec.seed,
    params: spec.params,
  };
}

export function recipeVersionIdentity(version) {
  return {
    schema: version.schema,
    params: version.params,
  };
}

export function deriveSubstreamSeed(seed, name) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be uint32');
  if (!['layout', 'gameplay', 'visual'].includes(name)) throw new RangeError(`unknown sort RNG substream: ${String(name)}`);
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(`${name}:${seed}`)) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return hash;
}
