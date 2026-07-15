#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalize } from '../recipes/sort/levels/jcs.mjs';
import {
  RUNTIME_ARTIFACT_MANIFEST,
  verifyRuntimeArtifact,
} from '../worker/runtime-artifact.mjs';

export const RUNTIME_RELEASE_DESCRIPTOR = 'runtime-release.json';

const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const CAPABILITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const RELEASE_ELIGIBLE_QA_PURPOSES = new Set([
  'level-spec-oracle-qa-base-only',
  'skin-spec-presentation-qa-base-only',
]);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(repoRoot, '..');

function fail(message) {
  throw new Error(String(message).replace(/\s+/g, ' ').trim());
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeId(value, label) {
  const normalized = String(value || '');
  if (!SAFE_ID.test(normalized) || normalized === '.' || normalized === '..') {
    fail(`${label} is not a safe path segment`);
  }
  return normalized;
}

function safeRelativePath(value, label) {
  const normalized = String(value || '');
  if (
    !normalized
    || normalized.includes('\\')
    || normalized.includes('\0')
    || normalized.startsWith('/')
    || normalized === '.'
    || normalized !== path.posix.normalize(normalized)
    || normalized.startsWith('../')
  ) fail(`${label} is not a safe relative path`);
  return normalized;
}

function readRegularFile(file, label) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { fail(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file`);
  return readFileSync(file);
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function directoryTree(root, current = root) {
  const files = [];
  const directories = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) fail(`runtime release may not contain symlinks: ${relative}`);
    if (entry.isDirectory()) {
      directories.push(relative);
      const nested = directoryTree(root, absolute);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else if (entry.isFile()) files.push(relative);
    else fail(`runtime release contains an unsupported filesystem entry: ${relative}`);
  }
  return { files: files.sort(), directories: directories.sort() };
}

function expectedDirectories(files) {
  const result = new Set();
  for (const file of files) {
    let parent = path.posix.dirname(file);
    while (parent !== '.') {
      result.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...result].sort();
}

function assertDirectory(root, label) {
  let stat;
  try { stat = lstatSync(root); }
  catch (error) { fail(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a non-symlink directory`);
}

function assertExistingDirectoryChain(platformRoot, parts) {
  assertDirectory(platformRoot, 'platform root');
  let current = platformRoot;
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    assertDirectory(current, `runtime release directory ${part}`);
  }
}

function assertPinnedBaseline(catalog, baselineId, wrapper, runtime) {
  if (catalog?.schemaVersion !== 1 || !catalog.baselines || typeof catalog.baselines !== 'object') {
    fail('QA baseline catalog is invalid');
  }
  const pin = catalog.baselines[baselineId];
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) fail(`QA baseline pin ${baselineId} is unavailable`);
  if (
    wrapper?.schemaVersion !== 1
    || wrapper.id !== baselineId
    || !RELEASE_ELIGIBLE_QA_PURPOSES.has(wrapper.purpose)
    || wrapper.releasePlayable !== false
    || pin.releasePlayable !== false
    || pin.artifactPath !== `bases/${baselineId}`
    || pin.template !== 'sort'
    || pin.sourceRepository !== wrapper.sourceRepository
    || pin.sourceCommit !== wrapper.sourceCommit
    || pin.sourceTree !== wrapper.sourceTree
    || pin.sourcePath !== wrapper.sourcePath
    || pin.runtimeContractDigest !== wrapper.runtimeContractDigest
    || pin.runtimeArtifactDigest !== wrapper.runtimeArtifactDigest
    || !isDeepStrictEqual(pin.capabilities, wrapper.capabilities)
  ) fail('QA wrapper does not match its immutable baseline pin or is release-playable');
  if (
    !GIT_OBJECT.test(String(wrapper.sourceCommit || ''))
    || !GIT_OBJECT.test(String(wrapper.sourceTree || ''))
    || !RAW_DIGEST.test(String(wrapper.runtimeContractDigest || ''))
    || !PREFIXED_DIGEST.test(String(wrapper.runtimeArtifactDigest || ''))
    || runtime.digest !== wrapper.runtimeArtifactDigest
    || runtime.manifest.sourceCommit !== wrapper.sourceCommit
    || path.posix.basename(safeRelativePath(wrapper.sourcePath, 'QA sourcePath')) !== runtime.manifest.playableId
  ) fail('QA wrapper source or runtime identity is invalid');
  if (!wrapper.capabilities || typeof wrapper.capabilities !== 'object' || Array.isArray(wrapper.capabilities)) {
    fail('QA wrapper capabilities are invalid');
  }
  const capabilityKeys = Object.keys(wrapper.capabilities);
  if (!capabilityKeys.length || capabilityKeys.some((key) => !CAPABILITY.test(key) || typeof wrapper.capabilities[key] !== 'boolean')) {
    fail('QA wrapper capabilities must be a non-empty boolean map');
  }
  return pin;
}

function captureBaseline({ baselineRoot, catalogFile, baselineId, mechanic, variant }) {
  assertDirectory(baselineRoot, 'QA baseline root');
  const wrapperFile = path.join(baselineRoot, 'manifest.json');
  const wrapperBytes = readRegularFile(wrapperFile, 'QA wrapper manifest');
  const wrapper = parseJson(wrapperBytes, 'QA wrapper manifest');
  if (wrapper.releasePlayable !== false) fail('QA wrapper must declare releasePlayable:false');

  const catalog = parseJson(readRegularFile(catalogFile, 'QA baseline catalog'), 'QA baseline catalog');
  const expectedPlayableId = safeId(path.posix.basename(String(wrapper.sourcePath || '')), 'playableId');
  const runtime = verifyRuntimeArtifact(baselineRoot, {
    expectedDigest: String(wrapper.runtimeArtifactDigest || ''),
    expectedPlayableId,
  });
  const pin = assertPinnedBaseline(catalog, baselineId, wrapper, runtime);
  if (mechanic !== pin.template) fail(`mechanic ${mechanic} differs from QA baseline template ${pin.template}`);

  const executablePaths = [...runtime.executablePaths];
  if (!executablePaths.includes('index.html')) fail('runtime sidecar must declare index.html');
  const wrapperFiles = wrapper.files;
  if (!wrapperFiles || typeof wrapperFiles !== 'object' || Array.isArray(wrapperFiles)) {
    fail('QA wrapper file allowlist is invalid');
  }
  const allowed = [...executablePaths, RUNTIME_ARTIFACT_MANIFEST].sort();
  const named = Object.keys(wrapperFiles).map((entry) => safeRelativePath(entry, 'QA wrapper file path')).sort();
  if (!isDeepStrictEqual(named, allowed)) fail('QA wrapper file allowlist differs from runtime sidecar');

  const files = new Map();
  for (const relative of allowed) {
    const bytes = readRegularFile(path.join(baselineRoot, relative), `QA baseline file ${relative}`);
    const digest = sha256(bytes);
    if (!PREFIXED_DIGEST.test(String(wrapperFiles[relative] || '')) || wrapperFiles[relative] !== digest) {
      fail(`QA baseline file ${relative} differs from its wrapper digest`);
    }
    files.set(relative, bytes);
  }

  const playableId = safeId(runtime.manifest.playableId, 'playableId');
  const runtimeArtifactDigest = runtime.digest;
  const artifactDigestHex = runtimeArtifactDigest.slice('sha256:'.length);
  const descriptor = Object.freeze({
    schema: 'runtime-release.v1',
    releasePlayable: true,
    mechanic,
    variant,
    playableId,
    sourceRepository: wrapper.sourceRepository,
    sourceCommit: wrapper.sourceCommit,
    sourceTree: wrapper.sourceTree,
    sourcePath: wrapper.sourcePath,
    qaBaselineId: baselineId,
    qaManifestDigest: sha256(wrapperBytes),
    runtimeContractDigest: wrapper.runtimeContractDigest,
    runtimeArtifactDigest,
    indexPath: 'index.html',
    sidecarPath: RUNTIME_ARTIFACT_MANIFEST,
    capabilities: structuredClone(wrapper.capabilities),
  });
  files.set(RUNTIME_RELEASE_DESCRIPTOR, Buffer.from(canonicalize(descriptor), 'utf8'));
  return { descriptor, files, artifactDigestHex, playableId };
}

function assertExactRelease(targetRoot, plan) {
  assertDirectory(targetRoot, 'runtime release target');
  const expectedFiles = [...plan.files.keys()].sort();
  const tree = directoryTree(targetRoot);
  if (!isDeepStrictEqual(tree.files, expectedFiles) || !isDeepStrictEqual(tree.directories, expectedDirectories(expectedFiles))) {
    fail('existing runtime release file set differs from the content-addressed release');
  }
  for (const relative of expectedFiles) {
    const actual = readRegularFile(path.join(targetRoot, relative), `runtime release file ${relative}`);
    if (!actual.equals(plan.files.get(relative))) fail(`existing runtime release byte mismatch: ${relative}`);
  }
  const verified = verifyRuntimeArtifact(targetRoot, {
    expectedDigest: plan.descriptor.runtimeArtifactDigest,
    expectedPlayableId: plan.descriptor.playableId,
    wrapperMetadata: [RUNTIME_RELEASE_DESCRIPTOR],
  });
  if (verified.digest !== plan.descriptor.runtimeArtifactDigest) fail('runtime release verification returned a different digest');
}

function writePlan(stagingRoot, plan) {
  mkdirSync(stagingRoot, { recursive: false, mode: 0o755 });
  for (const [relative, bytes] of plan.files) {
    const safe = safeRelativePath(relative, 'runtime release output path');
    const target = path.resolve(stagingRoot, ...safe.split('/'));
    if (!target.startsWith(`${stagingRoot}${path.sep}`)) fail('runtime release output path escapes staging root');
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
  }
  assertExactRelease(stagingRoot, plan);
}

/**
 * Turn an immutable QA wrapper into a separate, content-addressed deployable
 * release. The QA manifest is evidence only and is deliberately never copied.
 */
export function promoteRuntimeRelease({
  baselineRoot = path.join(repoRoot, 'bases', 'sort-v2-levels-qa'),
  catalogFile = path.join(repoRoot, 'generator', 'baselines.json'),
  baselineId = 'sort-v2-levels-qa',
  platformRoot = path.join(workspaceRoot, 'swipe-platform'),
  mechanic = 'sort',
  variant = 'base',
  mode = 'check',
} = {}) {
  if (!['check', 'write'].includes(mode)) fail('promotion mode must be check or write');
  baselineId = safeId(baselineId, 'QA baseline id');
  mechanic = safeId(mechanic, 'mechanic');
  variant = safeId(variant, 'variant');
  baselineRoot = path.resolve(String(baselineRoot || ''));
  catalogFile = path.resolve(String(catalogFile || ''));
  platformRoot = path.resolve(String(platformRoot || ''));

  const plan = captureBaseline({ baselineRoot, catalogFile, baselineId, mechanic, variant });
  const relativeTarget = path.posix.join('runtime-releases', plan.playableId, plan.artifactDigestHex);
  const targetRoot = path.resolve(platformRoot, ...relativeTarget.split('/'));
  if (!targetRoot.startsWith(`${platformRoot}${path.sep}`)) fail('runtime release target escapes platform root');
  assertExistingDirectoryChain(platformRoot, ['runtime-releases', plan.playableId, plan.artifactDigestHex]);

  if (existsSync(targetRoot)) {
    assertExactRelease(targetRoot, plan);
    return Object.freeze({
      status: 'replayed',
      mode,
      target: relativeTarget,
      descriptor: structuredClone(plan.descriptor),
    });
  }
  if (mode === 'check') {
    return Object.freeze({
      status: 'would_create',
      mode,
      target: relativeTarget,
      descriptor: structuredClone(plan.descriptor),
    });
  }

  const releasesRoot = path.join(platformRoot, 'runtime-releases');
  const playableRoot = path.join(releasesRoot, plan.playableId);
  mkdirSync(releasesRoot, { recursive: true, mode: 0o755 });
  assertDirectory(releasesRoot, 'runtime releases root');
  mkdirSync(playableRoot, { recursive: true, mode: 0o755 });
  assertDirectory(playableRoot, 'runtime playable release root');
  const stagingRoot = path.join(playableRoot, `.promote-${plan.artifactDigestHex}-${randomBytes(8).toString('hex')}`);
  try {
    writePlan(stagingRoot, plan);
    assertExistingDirectoryChain(platformRoot, ['runtime-releases', plan.playableId]);
    try {
      renameSync(stagingRoot, targetRoot);
    } catch (error) {
      if (!existsSync(targetRoot)) throw error;
      assertExactRelease(targetRoot, plan);
      rmSync(stagingRoot, { recursive: true, force: true });
      return Object.freeze({
        status: 'replayed',
        mode,
        target: relativeTarget,
        descriptor: structuredClone(plan.descriptor),
      });
    }
    assertExactRelease(targetRoot, plan);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    status: 'created',
    mode,
    target: relativeTarget,
    descriptor: structuredClone(plan.descriptor),
  });
}

function parseArgs(argv) {
  const options = { mode: 'check' };
  const valueFlags = new Map([
    ['--baseline', 'baselineRoot'],
    ['--catalog', 'catalogFile'],
    ['--baseline-id', 'baselineId'],
    ['--platform', 'platformRoot'],
    ['--mechanic', 'mechanic'],
    ['--variant', 'variant'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check' || arg === '--write') {
      const requested = arg.slice(2);
      if (options._modeSeen && options.mode !== requested) fail('choose either --check or --write, not both');
      options.mode = requested;
      options._modeSeen = true;
      continue;
    }
    if (arg === '--help') return { help: true };
    const field = valueFlags.get(arg);
    if (!field || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`unknown or incomplete argument: ${arg}`);
    options[field] = argv[index + 1];
    index += 1;
  }
  delete options._modeSeen;
  return options;
}

const invoked = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write([
        'Usage: node scripts/promote-runtime-release.mjs [--check|--write]',
        '  [--baseline <qa-root>] [--catalog <baselines.json>] [--baseline-id <id>]',
        '  [--platform <platform-root>] [--mechanic <id>] [--variant <id>]',
        '',
        'Default mode is --check; --write is required to materialize a release.',
        '',
      ].join('\n'));
    } else {
      process.stdout.write(`${canonicalize(promoteRuntimeRelease(options))}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
