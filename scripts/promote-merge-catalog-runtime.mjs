#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize } from '../recipes/sort/levels/jcs.mjs';
import { verifyRuntimeArtifact } from '../worker/runtime-artifact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VARIANT = /^raster-art-[0-9a-f]{12}$/;
const PLAYABLE_ID = 'merge-locked-v1-swipe';
const SOURCE_PATH = 'recipes/merge/art-v1';

function fail(code) { throw new Error(code); }
function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function readRegular(file, code) {
  let stat;
  try { stat = lstatSync(file); } catch { fail(code); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(code);
  return readFileSync(file);
}
function parse(bytes, code) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function assertAdapterQa(report, manifest) {
  if (!exactKeys(report, [
    'schema', 'runtimeContractDigest', 'runtimeArtifactDigest', 'specHash',
    'sourceHtmlSha256', 'sourceQaDocumentDigest', 'sourceQaEvidenceHash',
    'configured', 'completedCycle', 'gameplayEvents',
    'externalRequestCount', 'consoleErrorCount', 'mountMs',
  ])
    || report.schema !== 'merge.catalog-adapter-qa.v1'
    || report.runtimeContractDigest !== manifest.runtimeContractDigest
    || report.runtimeArtifactDigest !== manifest.runtimeArtifactDigest
    || report.specHash !== manifest.levelSpec?.specHash
    || report.sourceHtmlSha256 !== manifest.sourceHtmlSha256
    || report.sourceQaDocumentDigest !== manifest.levelSpec?.params?.qaReportDigest
    || report.sourceQaEvidenceHash !== manifest.levelSpec?.params?.sourceQaEvidenceHash
    || report.configured !== true
    || report.completedCycle !== true
    || JSON.stringify(report.gameplayEvents) !== JSON.stringify([{ type: 'progress' }, { type: 'progress' }, { type: 'progress' }])
    || report.externalRequestCount !== 0
    || report.consoleErrorCount !== 0
    || !Number.isInteger(report.mountMs)
    || report.mountMs < 0
    || report.mountMs > 15000) {
    fail('merge_catalog_adapter_qa_invalid');
  }
}

function exactRelease(root, files) {
  const names = readdirSync(root).sort();
  const expected = [...files.keys()].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('merge_catalog_release_file_set_mismatch');
  for (const [name, bytes] of files) {
    if (!readRegular(path.join(root, name), 'merge_catalog_release_file_missing').equals(bytes)) {
      fail('merge_catalog_release_byte_mismatch');
    }
  }
}

export function promoteMergeCatalogRuntime({
  runtimeRoot,
  platformRoot = path.join(workspaceRoot, 'swipe-platform'),
  mode = 'check',
} = {}) {
  if (!['check', 'write'].includes(mode)) fail('merge_catalog_promotion_mode_invalid');
  const root = path.resolve(String(runtimeRoot || ''));
  const manifestBytes = readRegular(path.join(root, 'catalog-runtime.json'), 'merge_catalog_runtime_manifest_missing');
  const manifest = parse(manifestBytes, 'merge_catalog_runtime_manifest_invalid');
  if (!exactKeys(manifest, [
    'schema', 'artPackHash', 'variant', 'sourceCandidateId', 'sourceHtmlSha256',
    'sourceRuntimeArtifactDigest', 'sourceCommit', 'runtimeContractDigest',
    'runtimeArtifactDigest', 'qaGateDigest', 'levelSpec', 'indexPath',
    'sidecarPath', 'sourceQaPath', 'adapterQaPath', 'capabilities',
  ])
    || manifest.schema !== 'merge.catalog-runtime-artifact.v1'
    || !HASH.test(String(manifest.artPackHash || ''))
    || manifest.variant !== `raster-art-${manifest.artPackHash.slice(0, 12)}`
    || !VARIANT.test(manifest.variant)
    || !COMMIT.test(String(manifest.sourceCommit || ''))
    || !HASH.test(String(manifest.runtimeContractDigest || ''))
    || !DIGEST.test(String(manifest.runtimeArtifactDigest || ''))
    || manifest.indexPath !== 'runtime/index.html'
    || manifest.sidecarPath !== 'runtime/runtime-artifact.json'
    || manifest.sourceQaPath !== 'evidence/source-qa.json'
    || manifest.adapterQaPath !== 'evidence/adapter-qa.json'
    || JSON.stringify(manifest.capabilities) !== JSON.stringify({ catalogRequiredHandshake: true, mergeRasterArtV1: true })) {
    fail('merge_catalog_runtime_manifest_invalid');
  }
  const runtime = verifyRuntimeArtifact(path.join(root, 'runtime'), {
    expectedDigest: manifest.runtimeArtifactDigest,
    expectedPlayableId: PLAYABLE_ID,
    wrapperMetadata: [],
  });
  if (runtime.manifest.sourceCommit !== manifest.sourceCommit
    || JSON.stringify(runtime.executablePaths) !== JSON.stringify(['bridge.js', 'index.html', 'inner.html'])) {
    fail('merge_catalog_runtime_closure_invalid');
  }
  const sourceQaBytes = readRegular(path.join(root, manifest.sourceQaPath), 'merge_catalog_source_qa_missing');
  if (digest(sourceQaBytes) !== manifest.levelSpec?.params?.qaReportDigest) {
    fail('merge_catalog_source_qa_digest_mismatch');
  }
  const qaBytes = readRegular(path.join(root, manifest.adapterQaPath), 'merge_catalog_adapter_qa_missing');
  const qa = parse(qaBytes, 'merge_catalog_adapter_qa_invalid');
  assertAdapterQa(qa, manifest);
  if (!qaBytes.equals(Buffer.from(canonicalize(qa), 'utf8'))) {
    fail('merge_catalog_adapter_qa_not_canonical');
  }
  let sourceTree;
  try {
    sourceTree = execFileSync('git', ['rev-parse', `${manifest.sourceCommit}:${SOURCE_PATH}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    fail('merge_catalog_source_commit_unavailable');
  }
  if (!COMMIT.test(sourceTree)) fail('merge_catalog_source_tree_invalid');
  const descriptor = {
    schema: 'runtime-release.v1',
    releasePlayable: true,
    mechanic: 'merge',
    variant: manifest.variant,
    playableId: PLAYABLE_ID,
    sourceRepository: 'swipe-ugc',
    sourceCommit: manifest.sourceCommit,
    sourceTree,
    sourcePath: SOURCE_PATH,
    qaBaselineId: `merge-raster-${manifest.artPackHash.slice(0, 12)}`,
    qaManifestDigest: digest(qaBytes),
    runtimeContractDigest: manifest.runtimeContractDigest,
    runtimeArtifactDigest: manifest.runtimeArtifactDigest,
    indexPath: 'index.html',
    sidecarPath: 'runtime-artifact.json',
    capabilities: manifest.capabilities,
  };
  const descriptorBytes = Buffer.from(canonicalize(descriptor), 'utf8');
  const files = new Map([
    ['bridge.js', readRegular(path.join(root, 'runtime/bridge.js'), 'merge_catalog_runtime_bridge_missing')],
    ['index.html', readRegular(path.join(root, manifest.indexPath), 'merge_catalog_runtime_index_missing')],
    ['inner.html', readRegular(path.join(root, 'runtime/inner.html'), 'merge_catalog_runtime_inner_missing')],
    ['runtime-artifact.json', readRegular(path.join(root, manifest.sidecarPath), 'merge_catalog_runtime_sidecar_missing')],
    ['runtime-release.json', descriptorBytes],
  ]);
  const targetRelative = path.posix.join('runtime-releases', PLAYABLE_ID, manifest.runtimeArtifactDigest.slice(7));
  const target = path.resolve(platformRoot, ...targetRelative.split('/'));
  if (!target.startsWith(`${path.resolve(platformRoot)}${path.sep}`)) fail('merge_catalog_release_target_invalid');
  if (existsSync(target)) {
    exactRelease(target, files);
    return { status: 'replayed', mode, target: targetRelative, descriptor };
  }
  if (mode === 'check') return { status: 'would_create', mode, target: targetRelative, descriptor };
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.promote-${manifest.runtimeArtifactDigest.slice(7)}-${randomBytes(8).toString('hex')}`);
  mkdirSync(staging, { mode: 0o755 });
  try {
    for (const [name, bytes] of files) writeFileSync(path.join(staging, name), bytes, { flag: 'wx', mode: 0o644 });
    exactRelease(staging, files);
    try { renameSync(staging, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      exactRelease(target, files);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  exactRelease(target, files);
  return { status: 'created', mode, target: targetRelative, descriptor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { mode: 'check' };
  for (let index = 2; index < process.argv.length; index += 1) {
    const name = process.argv[index];
    if (name === '--write') options.mode = 'write';
    else {
      const value = process.argv[++index];
      if (!value) fail(`${name}_requires_value`);
      if (name === '--runtime-root') options.runtimeRoot = path.resolve(value);
      else if (name === '--platform') options.platformRoot = path.resolve(value);
      else fail('merge_catalog_promotion_option_invalid');
    }
  }
  if (!options.runtimeRoot) fail('merge_catalog_promotion_input_missing');
  console.log(JSON.stringify(promoteMergeCatalogRuntime(options), null, 2));
}
