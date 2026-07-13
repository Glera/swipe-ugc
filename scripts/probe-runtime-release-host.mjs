#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Jcs } from '../recipes/sort/levels/jcs.mjs';
import {
  RUNTIME_ARTIFACT_MANIFEST,
  verifyRuntimeArtifact,
} from '../worker/runtime-artifact.mjs';

export const RUNTIME_RELEASE_DESCRIPTOR = 'runtime-release.json';
export const TRUSTED_HOST_PROBE_SCHEMA = 'runtime-release-host-verification.v1';

export const DEFAULT_TRUSTED_HOST_PROBE_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  overallTimeoutMs: 20_000,
  maxDescriptorBytes: 64 * 1024,
  maxSidecarBytes: 256 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 64,
});

const RAW_DIGEST = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CAPABILITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const SAFE_URL_PATH = /^[A-Za-z0-9._/-]+$/;
const DESCRIPTOR_KEYS = Object.freeze([
  'capabilities',
  'indexPath',
  'mechanic',
  'playableId',
  'qaBaselineId',
  'qaManifestDigest',
  'releasePlayable',
  'runtimeArtifactDigest',
  'runtimeContractDigest',
  'schema',
  'sidecarPath',
  'sourceCommit',
  'sourcePath',
  'sourceRepository',
  'sourceTree',
  'variant',
]);
const REGISTRATION_KEYS = Object.freeze([
  'delivery',
  'descriptor',
  'descriptorHash',
  'legacyVariantId',
  'releaseId',
  'requestHash',
  'schema',
]);
const DELIVERY_KEYS = Object.freeze(['indexLocator', 'sidecarLocator']);

function fail(message) {
  throw new Error(String(message).replace(/\s+/g, ' ').trim());
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObject(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain JSON object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has missing or extra fields`);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || !SAFE_URL_PATH.test(value)
    || value.includes('\\')
    || value.startsWith('/')
    || value === '.'
    || value !== path.posix.normalize(value)
    || value.startsWith('../')
  ) fail(`${label} is not a safe canonical relative URL path`);
  return value;
}

function validateDescriptor(descriptor) {
  assertExactObject(descriptor, DESCRIPTOR_KEYS, 'runtime release descriptor');
  if (descriptor.schema !== 'runtime-release.v1' || descriptor.releasePlayable !== true) {
    fail('runtime release descriptor is not release-playable v1');
  }
  for (const field of ['mechanic', 'variant', 'playableId', 'sourceRepository', 'qaBaselineId']) {
    if (typeof descriptor[field] !== 'string' || !SAFE_ID.test(descriptor[field])) {
      fail(`runtime release descriptor ${field} is invalid`);
    }
  }
  if (!GIT_OBJECT.test(String(descriptor.sourceCommit || '')) || !GIT_OBJECT.test(String(descriptor.sourceTree || ''))) {
    fail('runtime release descriptor source identity is invalid');
  }
  if (!PREFIXED_DIGEST.test(String(descriptor.qaManifestDigest || ''))
    || !PREFIXED_DIGEST.test(String(descriptor.runtimeArtifactDigest || ''))
    || !RAW_DIGEST.test(String(descriptor.runtimeContractDigest || ''))) {
    fail('runtime release descriptor digest identity is invalid');
  }
  safeRelativePath(descriptor.sourcePath, 'runtime release sourcePath');
  safeRelativePath(descriptor.indexPath, 'runtime release indexPath');
  safeRelativePath(descriptor.sidecarPath, 'runtime release sidecarPath');
  if (descriptor.sidecarPath !== RUNTIME_ARTIFACT_MANIFEST) {
    fail(`trusted host probe requires sidecarPath ${RUNTIME_ARTIFACT_MANIFEST}`);
  }
  if (descriptor.indexPath === descriptor.sidecarPath || descriptor.indexPath === RUNTIME_RELEASE_DESCRIPTOR) {
    fail('runtime release descriptor paths collide with wrapper metadata');
  }
  if (!isPlainObject(descriptor.capabilities) || Object.keys(descriptor.capabilities).length < 1) {
    fail('runtime release descriptor capabilities are invalid');
  }
  for (const [name, enabled] of Object.entries(descriptor.capabilities)) {
    if (!CAPABILITY.test(name) || typeof enabled !== 'boolean') {
      fail('runtime release descriptor capabilities are invalid');
    }
  }
  return descriptor;
}

export function canonicalRuntimeOrigin(value) {
  if (typeof value !== 'string' || !value) fail('runtime origin is required');
  let parsed;
  try { parsed = new URL(value); }
  catch { fail('runtime origin must be an origin-only HTTP(S) URL'); }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || value !== parsed.origin
  ) fail('runtime origin must be canonical and contain no path, credentials, query, or fragment');
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (parsed.protocol === 'http:' && !loopback.has(parsed.hostname)) {
    fail('runtime origin must use HTTPS outside loopback');
  }
  return parsed.origin;
}

function validateLocator(locator, expectedRelative, origin, label) {
  if (typeof locator !== 'string' || locator.length < 1 || locator.length > 1024) {
    fail(`${label} is invalid`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(locator)) {
    let parsed;
    try { parsed = new URL(locator); }
    catch { fail(`${label} is not a valid absolute URL`); }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.origin !== origin
      || parsed.pathname !== `/${expectedRelative}`
      || locator !== `${origin}/${expectedRelative}`
    ) fail(`${label} must be the exact same-origin HTTPS content-addressed URL`);
    return locator;
  }
  if (locator !== expectedRelative) fail(`${label} must be the exact content-addressed relative path`);
  return locator;
}

function validateRegistration(registration, origin) {
  assertExactObject(registration, REGISTRATION_KEYS, 'runtime release registration');
  if (registration.schema !== 'runtime-release-registration.v1') fail('runtime release registration schema is invalid');
  if (!UUID.test(String(registration.releaseId || ''))) fail('runtime release registration releaseId is invalid');
  if (registration.legacyVariantId !== null && !UUID.test(String(registration.legacyVariantId || ''))) {
    fail('runtime release registration legacyVariantId is invalid');
  }
  validateDescriptor(registration.descriptor);
  if (!RAW_DIGEST.test(String(registration.descriptorHash || ''))
    || registration.descriptorHash !== sha256Jcs(registration.descriptor)) {
    fail('runtime release registration descriptorHash is invalid');
  }
  assertExactObject(registration.delivery, DELIVERY_KEYS, 'runtime release delivery');
  const artifactHex = registration.descriptor.runtimeArtifactDigest.slice('sha256:'.length);
  const contentRoot = `runtime-releases/${registration.descriptor.playableId}/${artifactHex}`;
  validateLocator(
    registration.delivery.indexLocator,
    `${contentRoot}/${registration.descriptor.indexPath}`,
    origin,
    'runtime release indexLocator',
  );
  validateLocator(
    registration.delivery.sidecarLocator,
    `${contentRoot}/${registration.descriptor.sidecarPath}`,
    origin,
    'runtime release sidecarLocator',
  );
  if (!RAW_DIGEST.test(String(registration.requestHash || ''))) fail('runtime release registration requestHash is invalid');
  const withoutRequestHash = Object.fromEntries(
    Object.entries(registration).filter(([key]) => key !== 'requestHash'),
  );
  if (registration.requestHash !== sha256Jcs(withoutRequestHash)) {
    fail('runtime release registration requestHash is invalid');
  }
  return Object.freeze({ contentRoot, descriptor: registration.descriptor });
}

function normalizedLimits(overrides = {}) {
  if (!isPlainObject(overrides)) fail('trusted host probe limits must be an object');
  const unknown = Object.keys(overrides).filter((key) => !(key in DEFAULT_TRUSTED_HOST_PROBE_LIMITS));
  if (unknown.length) fail(`unknown trusted host probe limit: ${unknown.join(', ')}`);
  const limits = { ...DEFAULT_TRUSTED_HOST_PROBE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`trusted host probe limit ${name} must be a positive integer`);
  }
  return Object.freeze(limits);
}

async function cancelBody(response) {
  try { await response?.body?.cancel(); }
  catch { /* best effort connection cleanup */ }
}

async function fetchBounded(url, {
  fetchImpl,
  label,
  maxBytes,
  timeoutMs,
  deadline,
  budget,
}) {
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs < 1) fail('trusted host probe exceeded its overall timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remainingMs));
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: '*/*',
        'accept-encoding': 'identity',
        'cache-control': 'no-cache',
      },
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number') fail(`${label} returned an invalid response`);
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      fail(`${label} attempted an unsafe redirect`);
    }
    if (response.status !== 200) {
      await cancelBody(response);
      fail(`${label} returned HTTP ${response.status}`);
    }
    if (response.redirected || response.url !== url) {
      await cancelBody(response);
      fail(`${label} response URL differs from the exact trusted URL`);
    }
    const contentEncoding = String(response.headers.get('content-encoding') || '').trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      await cancelBody(response);
      fail(`${label} ignored the identity content-encoding requirement`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^[0-9]+$/.test(contentLength)) fail(`${label} returned an invalid Content-Length`);
      const stated = Number(contentLength);
      if (!Number.isSafeInteger(stated) || stated > maxBytes || stated > budget.remaining) {
        await cancelBody(response);
        fail(`${label} exceeds the trusted host probe byte limit`);
      }
    }
    if (!response.body || typeof response.body.getReader !== 'function') fail(`${label} returned no bounded response body`);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > maxBytes || received > budget.remaining) {
          await reader.cancel();
          fail(`${label} exceeds the trusted host probe byte limit`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    budget.remaining -= received;
    return Buffer.concat(chunks, received);
  } catch (error) {
    if (controller.signal.aborted) fail(`${label} timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function declaredRuntimeFiles(sidecar, descriptor, limits, remainingBudget) {
  if (!isPlainObject(sidecar)
    || sidecar.schema !== 'runtime-artifact.v1'
    || sidecar.playableId !== descriptor.playableId
    || sidecar.digest !== descriptor.runtimeArtifactDigest
    || sidecar.sourceCommit !== descriptor.sourceCommit
    || !Array.isArray(sidecar.files)
    || sidecar.files.length < 1
    || sidecar.files.length > limits.maxFiles) {
    fail('runtime artifact sidecar identity or file list is invalid');
  }
  const entries = sidecar.files.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`runtime artifact sidecar file ${index} is invalid`);
    const relative = safeRelativePath(entry.path, `runtime artifact sidecar file ${index}`);
    if (relative === RUNTIME_ARTIFACT_MANIFEST || relative === RUNTIME_RELEASE_DESCRIPTOR) {
      fail('runtime artifact executable path collides with wrapper metadata');
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > limits.maxFileBytes
      || !PREFIXED_DIGEST.test(String(entry.sha256 || ''))) {
      fail(`runtime artifact sidecar file ${relative} exceeds limits or has invalid identity`);
    }
    return Object.freeze({ path: relative, bytes: entry.bytes, sha256: entry.sha256 });
  });
  const paths = entries.map((entry) => entry.path);
  const sorted = [...paths].sort();
  if (new Set(paths).size !== paths.length || paths.some((value, index) => value !== sorted[index])) {
    fail('runtime artifact sidecar paths must be unique and sorted');
  }
  if (!paths.includes(descriptor.indexPath)) fail('runtime artifact sidecar does not declare descriptor indexPath');
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(total) || total > remainingBudget) {
    fail('runtime artifact sidecar declared files exceed the trusted host probe total byte limit');
  }
  return entries;
}

function writeProbeFile(root, relative, bytes) {
  const safe = safeRelativePath(relative, 'trusted host probe output path');
  const target = path.resolve(root, ...safe.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) fail('trusted host probe output path escapes scratch root');
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
}

function verifiedAt(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.valueOf())) fail('trusted host probe clock returned an invalid timestamp');
  return date.toISOString();
}

/**
 * Re-fetch and verify an already deployed content-addressed runtime release.
 * The only durable output is a self-hashed evidence value; scratch bytes are
 * removed before this function resolves or rejects.
 */
export async function probeRuntimeReleaseHost({
  registration,
  origin,
  fetchImpl = globalThis.fetch,
  now,
  limits: limitOverrides = {},
} = {}) {
  if (typeof fetchImpl !== 'function') fail('trusted host probe requires fetch');
  const canonicalOrigin = canonicalRuntimeOrigin(origin);
  const identity = validateRegistration(registration, canonicalOrigin);
  const limits = normalizedLimits(limitOverrides);
  const budget = { remaining: limits.maxTotalBytes };
  const deadline = performance.now() + limits.overallTimeoutMs;
  const rootUrl = `${canonicalOrigin}/${identity.contentRoot}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'trusted-host-probe-'));
  try {
    const descriptorUrl = `${rootUrl}/${RUNTIME_RELEASE_DESCRIPTOR}`;
    const descriptorBytes = await fetchBounded(descriptorUrl, {
      fetchImpl,
      label: 'runtime release descriptor',
      maxBytes: limits.maxDescriptorBytes,
      timeoutMs: limits.timeoutMs,
      deadline,
      budget,
    });
    const expectedDescriptorBytes = Buffer.from(canonicalize(identity.descriptor), 'utf8');
    if (!descriptorBytes.equals(expectedDescriptorBytes)
      || sha256(descriptorBytes).slice('sha256:'.length) !== registration.descriptorHash) {
      fail('hosted runtime-release.json differs from the exact registered descriptor');
    }
    validateDescriptor(parseJson(descriptorBytes, 'hosted runtime release descriptor'));
    writeProbeFile(scratch, RUNTIME_RELEASE_DESCRIPTOR, descriptorBytes);

    const sidecarUrl = `${rootUrl}/${identity.descriptor.sidecarPath}`;
    const sidecarBytes = await fetchBounded(sidecarUrl, {
      fetchImpl,
      label: 'runtime artifact sidecar',
      maxBytes: limits.maxSidecarBytes,
      timeoutMs: limits.timeoutMs,
      deadline,
      budget,
    });
    const sidecar = parseJson(sidecarBytes, 'runtime artifact sidecar');
    const entries = declaredRuntimeFiles(sidecar, identity.descriptor, limits, budget.remaining);
    writeProbeFile(scratch, identity.descriptor.sidecarPath, sidecarBytes);

    const downloaded = new Map();
    for (const entry of entries) {
      const bytes = await fetchBounded(`${rootUrl}/${entry.path}`, {
        fetchImpl,
        label: `runtime executable ${entry.path}`,
        maxBytes: Math.min(limits.maxFileBytes, entry.bytes),
        timeoutMs: limits.timeoutMs,
        deadline,
        budget,
      });
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        fail(`runtime executable integrity mismatch: ${entry.path}`);
      }
      writeProbeFile(scratch, entry.path, bytes);
      downloaded.set(entry.path, bytes);
    }

    const verified = verifyRuntimeArtifact(scratch, {
      expectedDigest: identity.descriptor.runtimeArtifactDigest,
      expectedPlayableId: identity.descriptor.playableId,
      wrapperMetadata: [RUNTIME_RELEASE_DESCRIPTOR],
    });
    if (verified.digest !== identity.descriptor.runtimeArtifactDigest) {
      fail('trusted host verification returned a different runtime artifact digest');
    }
    if (performance.now() > deadline) fail('trusted host probe exceeded its overall timeout');
    const indexBytes = downloaded.get(identity.descriptor.indexPath);
    if (!indexBytes) fail('trusted host verification did not download descriptor indexPath');

    const evidence = {
      schema: TRUSTED_HOST_PROBE_SCHEMA,
      releaseId: registration.releaseId,
      descriptorHash: registration.descriptorHash,
      origin: canonicalOrigin,
      indexLocator: registration.delivery.indexLocator,
      sidecarLocator: registration.delivery.sidecarLocator,
      runtimeArtifactDigest: identity.descriptor.runtimeArtifactDigest,
      indexDigest: sha256(indexBytes),
      sidecarDigest: sha256(sidecarBytes),
      probe: 'trusted-host-probe.v1',
      verifiedAt: verifiedAt(now),
    };
    evidence.evidenceDigest = sha256Jcs(evidence);
    return Object.freeze(evidence);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readRegistrationFile(file) {
  const absolute = path.resolve(String(file || ''));
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) { fail(`registration file is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('registration file must be a regular non-symlink file');
  if (stat.size > 1024 * 1024) fail('registration input exceeds 1 MiB');
  return readFileSync(absolute);
}

async function readStdinBounded() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 1024 * 1024) fail('registration input exceeds 1 MiB');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function parseArgs(argv) {
  const options = { mode: 'check' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') continue;
    if (arg === '--stdin') {
      if (options.stdin || options.registrationFile) fail('choose exactly one registration input');
      options.stdin = true;
      continue;
    }
    if (arg === '--help') return { help: true };
    if (arg === '--write') fail('trusted host probe has no write mode');
    if (arg === '--origin' || arg === '--registration') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`incomplete argument: ${arg}`);
      if (arg === '--origin') {
        if (options.origin !== undefined) fail('--origin may be provided only once');
        options.origin = argv[index + 1];
      } else {
        if (options.stdin || options.registrationFile) fail('choose exactly one registration input');
        options.registrationFile = argv[index + 1];
      }
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!options.origin) fail('--origin is required');
  if (!options.stdin && !options.registrationFile) fail('use --stdin or --registration <file>');
  return options;
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      'Usage: node scripts/probe-runtime-release-host.mjs [--check] --origin <origin>',
      '  (--stdin | --registration <runtime-release-registration.v1.json>)',
      '',
      'The default and only mode is read-only --check. Evidence is written as one JCS line.',
      '',
    ].join('\n'));
    return;
  }
  const input = options.stdin ? await readStdinBounded() : readRegistrationFile(options.registrationFile);
  const registration = parseJson(input, 'runtime release registration input');
  const evidence = await probeRuntimeReleaseHost({ registration, origin: options.origin });
  process.stdout.write(`${canonicalize(evidence)}\n`);
}

const invoked = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
