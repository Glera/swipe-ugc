import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

export const RUNTIME_ARTIFACT_MANIFEST = 'runtime-artifact.json';
export const RUNTIME_DIGEST_PLACEHOLDER = `sha256:${'0'.repeat(64)}`;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DOMAIN = Buffer.from('swipe.runtime-artifact.normalized.v1\0');

function safeRelativePath(value, label = 'runtime artifact path') {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')
    || value === '.'
    || value !== path.posix.normalize(value)
    || value.startsWith('../')
  ) throw new Error(`${label} is invalid`);
  return value;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function regularFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`runtime artifact may not contain symlinks: ${entry.name}`);
    if (entry.isDirectory()) files.push(...regularFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`runtime artifact contains an unsupported filesystem entry: ${entry.name}`);
  }
  return files.sort();
}

function replaceAll(bytes, needle, replacement) {
  if (needle.length !== replacement.length) throw new Error('runtime digest normalization must preserve byte length');
  const chunks = [];
  let offset = 0;
  let replacements = 0;
  while (offset <= bytes.length - needle.length) {
    const index = bytes.indexOf(needle, offset);
    if (index < 0) break;
    chunks.push(bytes.subarray(offset, index), replacement);
    offset = index + needle.length;
    replacements += 1;
  }
  if (!replacements) return { bytes, replacements: 0 };
  chunks.push(bytes.subarray(offset));
  return { bytes: Buffer.concat(chunks), replacements };
}

function framedDigest(files) {
  const hash = createHash('sha256');
  hash.update(DOMAIN);
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const nameLength = Buffer.alloc(4);
    const byteLength = Buffer.alloc(8);
    nameLength.writeUInt32BE(name.length);
    byteLength.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(nameLength).update(name).update(byteLength).update(file.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function manifestEntries(manifest) {
  if (!Array.isArray(manifest?.files) || manifest.files.length < 1) {
    throw new Error('runtime artifact manifest files are invalid');
  }
  const entries = manifest.files.map((entry) => {
    const relative = safeRelativePath(entry?.path);
    if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 || !DIGEST.test(String(entry?.sha256 || ''))) {
      throw new Error(`runtime artifact manifest entry is invalid: ${relative}`);
    }
    return { path: relative, bytes: entry.bytes, sha256: entry.sha256 };
  });
  const names = entries.map((entry) => entry.path);
  const sorted = [...names].sort();
  if (new Set(names).size !== names.length || names.some((name, index) => name !== sorted[index])) {
    throw new Error('runtime artifact manifest paths must be unique and sorted');
  }
  return entries;
}

/**
 * Verify an immutable executable bundle without rewriting any byte. Wrapper
 * metadata is allowed explicitly, but every executable file must be named by
 * the runtime sidecar and every file named by the sidecar must be present.
 */
export function verifyRuntimeArtifact(root, {
  expectedDigest = '',
  expectedPlayableId = 'marble-sort-swipe',
  wrapperMetadata = ['manifest.json'],
} = {}) {
  const absoluteRoot = path.resolve(String(root || ''));
  if (!lstatSync(absoluteRoot).isDirectory()) throw new Error('runtime artifact root must be a directory');
  const sidecarPath = path.join(absoluteRoot, RUNTIME_ARTIFACT_MANIFEST);
  if (!lstatSync(sidecarPath).isFile()) throw new Error('runtime artifact sidecar is missing');
  const manifest = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  if (
    manifest?.schema !== 'runtime-artifact.v1'
    || !DIGEST.test(String(manifest?.digest || ''))
    || String(manifest?.playableId || '') !== expectedPlayableId
  ) throw new Error('runtime artifact sidecar is invalid');
  if (expectedDigest && manifest.digest !== expectedDigest) throw new Error('runtime artifact digest differs from its QA pin');

  const entries = manifestEntries(manifest);
  const declared = entries.map((entry) => entry.path);
  const allowedMetadata = wrapperMetadata.map((name) => safeRelativePath(name, 'wrapper metadata path'));
  const actual = regularFiles(absoluteRoot);
  const expectedFiles = [...declared, RUNTIME_ARTIFACT_MANIFEST, ...allowedMetadata]
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedFiles)) {
    throw new Error(`runtime artifact file set differs from its sidecar: ${actual.join(', ')}`);
  }

  const embedded = Buffer.from(manifest.digest, 'utf8');
  const placeholder = Buffer.from(RUNTIME_DIGEST_PLACEHOLDER, 'utf8');
  let replacements = 0;
  const normalized = entries.map((entry) => {
    const absolute = path.join(absoluteRoot, entry.path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`runtime artifact file is not regular: ${entry.path}`);
    const original = readFileSync(absolute);
    if (original.length !== entry.bytes || sha256(original) !== entry.sha256) {
      throw new Error(`runtime artifact file integrity mismatch: ${entry.path}`);
    }
    const result = replaceAll(original, embedded, placeholder);
    replacements += result.replacements;
    return { path: entry.path, bytes: result.bytes };
  });
  if (replacements < 1) throw new Error('runtime artifact does not embed its digest');
  const digest = framedDigest(normalized);
  if (digest !== manifest.digest) {
    throw new Error(`runtime artifact normalized digest mismatch: expected ${manifest.digest}, got ${digest}`);
  }
  return Object.freeze({
    manifest,
    digest,
    executablePaths: Object.freeze([...declared]),
  });
}

export function sha256File(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`expected a regular file: ${file}`);
  return sha256(readFileSync(file));
}

export function isSha256Digest(value) {
  return DIGEST.test(String(value || ''));
}
