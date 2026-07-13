#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256File, verifyRuntimeArtifact } from './runtime-artifact.mjs';

export const SORT_LEVEL_QA_BASELINE = Object.freeze({
  id: 'sort-v2-levels-qa',
  sourceRepository: 'playables',
  sourceCommit: '23f6974269e361f022b1393559da4a67c7aaf651',
  sourceTree: '4048b492d966503e34c86db8b0dc3da719c4baf1',
  sourcePath: 'marble-sort-swipe',
  runtimeContractDigest: 'c79a84694f02dad356822fa1b3f3d039b8f056f23f1300ff536a072e54c3b625',
  runtimeArtifactDigest: 'sha256:d66b4e440358533410dd505f25b7558187df46ca5d8eea562d8648c62f2f9293',
  buildStamp: '2026-07-13 11:13',
  packageLockDigest: 'sha256:d5f581206398465ee3cd901beb81860f517f71edbc2217761ece2eefcfe8eae5',
  capabilities: Object.freeze({
    sortLevelSpecV1: true,
    catalogRequiredHandshake: true,
    logicalScheduler: true,
    virtualClockQa: true,
    oracleQa: true,
    realtimeOracleSmoke: true,
  }),
});

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspace = path.resolve(repoRoot, '..');
const outputRoot = path.join(repoRoot, 'bases', SORT_LEVEL_QA_BASELINE.id);
const DIGEST_PLACEHOLDER = `sha256:${'0'.repeat(64)}`;
const TOOLCHAIN_PACKAGES = ['matter-js', 'terser', 'vite', 'vite-plugin-singlefile'];

function fail(message) {
  throw new Error(String(message).replace(/\s+/g, ' ').trim());
}

function run(command, args, { cwd, env = process.env, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (!quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(result.stderr || result.stdout || `${command} exited ${result.status}`);
  }
  return String(result.stdout || '').trim();
}

function runBytes(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(result.stderr?.toString() || result.stdout?.toString() || `${command} exited ${result.status}`);
  return Buffer.from(result.stdout);
}

function git(root, ...args) {
  return run('git', args, { cwd: root, quiet: true });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function installedToolchain(nodeModules, lock) {
  const versions = {};
  for (const name of TOOLCHAIN_PACKAGES) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    const actual = JSON.parse(readFileSync(path.join(nodeModules, name, 'package.json'), 'utf8')).version;
    if (!expected || actual !== expected) fail(`installed ${name}@${actual} does not match pinned lock ${expected || 'missing'}`);
    versions[name] = actual;
  }
  return versions;
}

function sourceSnapshot(playablesRoot) {
  const actualCommit = git(playablesRoot, 'rev-parse', `${SORT_LEVEL_QA_BASELINE.sourceCommit}^{commit}`);
  const actualTree = git(playablesRoot, 'rev-parse', `${SORT_LEVEL_QA_BASELINE.sourceCommit}:${SORT_LEVEL_QA_BASELINE.sourcePath}`);
  if (actualCommit !== SORT_LEVEL_QA_BASELINE.sourceCommit || actualTree !== SORT_LEVEL_QA_BASELINE.sourceTree) {
    fail('pinned Sort QA source commit/tree is unavailable or mismatched');
  }
  const lockBytes = runBytes('git', ['cat-file', 'blob', `${SORT_LEVEL_QA_BASELINE.sourceCommit}:package-lock.json`], {
    cwd: playablesRoot,
  });
  if (sha256(lockBytes) !== SORT_LEVEL_QA_BASELINE.packageLockDigest) fail('pinned package-lock digest mismatched');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const nodeModules = realpathSync(path.join(playablesRoot, 'node_modules'));
  if (!lstatSync(nodeModules).isDirectory()) fail('trusted playables node_modules is unavailable');
  return { nodeModules, toolchain: installedToolchain(nodeModules, lock) };
}

function controlledBuildEnv() {
  const env = { ...process.env };
  for (const key of ['FORCE_DPR', 'FORCE_TIER', 'LEVEL']) delete env[key];
  return {
    ...env,
    NODE_ENV: 'production',
    PLAYABLE: SORT_LEVEL_QA_BASELINE.sourcePath,
    SWIPE: '1',
    TARGET: 'swipe',
    ASSET_FMT: 'avif',
    MRAID_MOCK: '0',
    DEBUG_PROD: '0',
    BUILD_STAMP: SORT_LEVEL_QA_BASELINE.buildStamp,
    RUNTIME_ARTIFACT_DIGEST: DIGEST_PLACEHOLDER,
  };
}

function copyRuntimeArtifact(distRoot, stagingRoot, runtimeManifest) {
  for (const entry of runtimeManifest.files) {
    const target = path.join(stagingRoot, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(distRoot, entry.path), target);
  }
  copyFileSync(path.join(distRoot, 'runtime-artifact.json'), path.join(stagingRoot, 'runtime-artifact.json'));
}

function wrapperManifest(stagingRoot, runtimeManifest, toolchain) {
  const runtimeFiles = [...runtimeManifest.files.map((entry) => entry.path), 'runtime-artifact.json'].sort();
  return {
    schemaVersion: 1,
    id: SORT_LEVEL_QA_BASELINE.id,
    purpose: 'level-spec-oracle-qa-base-only',
    sourceRepository: SORT_LEVEL_QA_BASELINE.sourceRepository,
    sourceCommit: SORT_LEVEL_QA_BASELINE.sourceCommit,
    sourceTree: SORT_LEVEL_QA_BASELINE.sourceTree,
    sourcePath: SORT_LEVEL_QA_BASELINE.sourcePath,
    runtimeContractDigest: SORT_LEVEL_QA_BASELINE.runtimeContractDigest,
    runtimeArtifactDigest: runtimeManifest.digest,
    build: {
      stampUtc: SORT_LEVEL_QA_BASELINE.buildStamp,
      packageLockDigest: SORT_LEVEL_QA_BASELINE.packageLockDigest,
      toolchain,
    },
    files: Object.fromEntries(runtimeFiles.map((relative) => [relative, sha256File(path.join(stagingRoot, relative))])),
    capabilities: SORT_LEVEL_QA_BASELINE.capabilities,
    releasePlayable: false,
  };
}

function relativeFiles(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...relativeFiles(root, absolute));
    else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return result.sort();
}

function assertSameArtifact(expectedRoot, actualRoot) {
  const expectedFiles = relativeFiles(expectedRoot);
  const actualFiles = relativeFiles(actualRoot);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) fail('QA baseline file list is not reproducible');
  for (const relative of expectedFiles) {
    if (sha256File(path.join(expectedRoot, relative)) !== sha256File(path.join(actualRoot, relative))) {
      fail(`QA baseline is not reproducible: ${relative} differs`);
    }
  }
}

function verifyPackagedBaseline(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const runtime = verifyRuntimeArtifact(root);
  if (
    manifest.id !== SORT_LEVEL_QA_BASELINE.id
    || manifest.runtimeContractDigest !== SORT_LEVEL_QA_BASELINE.runtimeContractDigest
    || manifest.runtimeArtifactDigest !== runtime.digest
    || manifest.releasePlayable !== false
  ) fail('packaged QA baseline manifest identity mismatch');
  for (const [relative, digest] of Object.entries(manifest.files || {})) {
    if (sha256File(path.join(root, relative)) !== digest) fail(`packaged QA baseline file mismatch: ${relative}`);
  }
  const payload = readFileSync(path.join(root, 'payload.js'), 'utf8');
  for (const marker of [
    SORT_LEVEL_QA_BASELINE.runtimeContractDigest,
    'sortQa',
    'advanceTicks',
    'chooseOracleAction',
    'applyOracleAction',
    'catalog_required',
  ]) {
    if (!payload.includes(marker)) fail(`QA baseline payload is missing ${marker}`);
  }
  return { manifest, runtime };
}

export function buildSortLevelQaBaseline({ mode = 'check', sourceGate = false } = {}) {
  if (!['check', 'write'].includes(mode)) fail('mode must be check or write');
  const playablesRoot = path.resolve(process.env.PLAYABLES_ROOT || path.join(workspace, 'playables'));
  const { nodeModules, toolchain } = sourceSnapshot(playablesRoot);
  const scratch = mkdtempSync(path.join(tmpdir(), 'sort-v2-levels-qa-'));
  try {
    const checkout = path.join(scratch, 'playables');
    run('git', ['clone', '--shared', '--no-checkout', playablesRoot, checkout], { cwd: scratch });
    run('git', ['checkout', '--detach', SORT_LEVEL_QA_BASELINE.sourceCommit], { cwd: checkout });
    symlinkSync(nodeModules, path.join(checkout, 'node_modules'), 'dir');
    symlinkSync(repoRoot, path.join(scratch, 'swipe-ugc'), 'dir');

    if (sourceGate) run('npm', ['run', 'test:sort-level-runtime'], { cwd: checkout });
    const viteCli = path.join(checkout, 'node_modules', 'vite', 'bin', 'vite.js');
    run(process.execPath, [viteCli, 'build'], { cwd: checkout, env: controlledBuildEnv() });
    const distRoot = path.join(checkout, SORT_LEVEL_QA_BASELINE.sourcePath, 'dist-swipe');
    const html = path.join(distRoot, 'index.html');
    run(process.execPath, [path.join(checkout, 'scripts', 'externalize-videos.mjs'), html], { cwd: checkout });
    run(process.execPath, [path.join(checkout, 'scripts', 'blob-boot-transform.mjs'), html], { cwd: checkout });
    const stampModule = path.join(checkout, 'scripts', 'stamp-runtime-artifact.mjs');
    const stampWrapper = path.join(scratch, 'stamp-runtime-artifact.mjs');
    writeFileSync(stampWrapper, [
      `import { stampRuntimeArtifact } from ${JSON.stringify(pathToFileURL(stampModule).href)};`,
      'const [root, playableId, sourceCommit] = process.argv.slice(2);',
      'console.log(stampRuntimeArtifact(root, { playableId, sourceCommit }).digest);',
      '',
    ].join('\n'));
    run(process.execPath, [
      stampWrapper,
      distRoot,
      SORT_LEVEL_QA_BASELINE.sourcePath,
      SORT_LEVEL_QA_BASELINE.sourceCommit,
    ], { cwd: checkout });
    const runtimeManifest = verifyRuntimeArtifact(distRoot, { wrapperMetadata: [] }).manifest;
    if (runtimeManifest.sourceCommit !== SORT_LEVEL_QA_BASELINE.sourceCommit) fail('runtime sidecar source commit mismatch');
    if (runtimeManifest.digest !== SORT_LEVEL_QA_BASELINE.runtimeArtifactDigest) {
      fail(`rebuilt runtime digest drifted from its QA pin: ${runtimeManifest.digest}`);
    }

    const stagingRoot = path.join(scratch, SORT_LEVEL_QA_BASELINE.id);
    mkdirSync(stagingRoot, { recursive: true });
    copyRuntimeArtifact(distRoot, stagingRoot, runtimeManifest);
    const manifest = wrapperManifest(stagingRoot, runtimeManifest, toolchain);
    writeFileSync(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    verifyPackagedBaseline(stagingRoot);

    if (mode === 'write') {
      rmSync(outputRoot, { recursive: true, force: true });
      cpSync(stagingRoot, outputRoot, { recursive: true });
      verifyPackagedBaseline(outputRoot);
    } else {
      if (!lstatSync(outputRoot).isDirectory()) fail(`QA baseline is missing: ${outputRoot}`);
      assertSameArtifact(outputRoot, stagingRoot);
      verifyPackagedBaseline(outputRoot);
    }
    return { outputRoot, manifest, runtimeManifest };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const invoked = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  if (process.argv.includes('--write') && process.argv.includes('--check')) {
    console.error('Choose either --check or --write, not both.');
    process.exit(1);
  }
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const sourceGate = process.argv.includes('--source-gate');
  if (process.argv.some((arg) => arg.startsWith('--') && !['--write', '--check', '--source-gate'].includes(arg))) {
    console.error('Usage: node scripts/build-sort-level-qa-baseline.mjs [--check|--write] [--source-gate]');
    process.exit(1);
  }
  const result = buildSortLevelQaBaseline({ mode, sourceGate });
  console.log(JSON.stringify({
    id: result.manifest.id,
    runtimeArtifactDigest: result.runtimeManifest.digest,
    files: result.manifest.files,
  }, null, 2));
}
