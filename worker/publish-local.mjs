// Hardened local persistence for the exact experiment-worker contract.
//
// Reads never follow symlinks and capture bytes exactly once (no pathname
// re-open between hash and use). Publication is append-only and race-safe:
// artifacts are staged, then committed with no-overwrite links in a fixed
// order with the manifest as the last commit marker; an existing candidate
// is either an identical replay or a typed conflict — never an overwrite.
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';

import {
  buildWorkerResult,
  canonicalJson,
  contractError,
  sha256Hex,
  verifyWorkerInput,
  verifyWorkerResult,
} from './result-contract.mjs';

const MAX_READ_BYTES = 64 * 1024 * 1024;

function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertTrustedRoot(root, label) {
  const resolved = path.resolve(root);
  let stat;
  let real;
  try {
    stat = lstatSync(resolved, { bigint: true });
    real = realpathSync(resolved);
  } catch {
    throw contractError('parent_unverifiable', `${label} trusted root is unavailable`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw contractError('parent_unverifiable', `${label} trusted root must be a real directory`);
  }
  return { requested: resolved, canonical: real };
}

function assertPlainAncestors(root, pathname, label) {
  const relative = path.relative(root, pathname);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError('parent_unverifiable', `${label} escapes its trusted root`);
  }
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current, { bigint: true }); } catch {
      throw contractError('parent_unverifiable', `${label} ancestor is unavailable`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw contractError('parent_unverifiable', `${label} ancestor must not be a symlink`);
    }
  }
}

// Single hardened read: every ancestor and the final pathname are no-follow;
// lstat/fstat/fstat/lstat must agree on inode, size, mtime and ctime; every
// later consumer uses these captured bytes instead of re-opening the path.
export function readFileExact(
  pathname,
  label,
  { trustedRoot = path.dirname(pathname), maxBytes = MAX_READ_BYTES, afterRead = null } = {},
) {
  const rootIdentity = assertTrustedRoot(trustedRoot, label);
  const requestedFile = path.resolve(pathname);
  const relative = path.relative(rootIdentity.requested, requestedFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError('parent_unverifiable', `${label} escapes its trusted root`);
  }
  const root = rootIdentity.canonical;
  const file = path.join(root, relative);
  assertPlainAncestors(root, file, label);
  let before;
  try { before = lstatSync(file, { bigint: true }); } catch {
    throw contractError('parent_unverifiable', `${label} is unavailable`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n
    || before.size > BigInt(maxBytes)) {
    throw contractError('parent_unverifiable', `${label} is not a bounded regular file`);
  }
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw contractError('parent_unverifiable', 'platform cannot open evidence without following links');
  }
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw contractError(
      'parent_unverifiable',
      `${label} is unreadable without following links: ${error.code || error.message}`,
    );
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileStat(before, opened)) {
      throw contractError('parent_changed', `${label} changed while it was opened`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw contractError('parent_changed', `${label} ended during evidence capture`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileStat(opened, after)) {
      throw contractError('parent_changed', `${label} changed during evidence capture`);
    }
    if (typeof afterRead === 'function') afterRead({ file, label });
    assertPlainAncestors(root, file, label);
    let linked;
    let real;
    try {
      linked = lstatSync(file, { bigint: true });
      real = realpathSync(file);
    } catch {
      throw contractError('parent_changed', `${label} pathname changed during evidence capture`);
    }
    if (!linked.isFile() || linked.isSymbolicLink() || !sameFileStat(opened, linked)
      || real !== file || !real.startsWith(`${root}${path.sep}`)) {
      throw contractError('parent_changed', `${label} pathname no longer names the captured file`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function loadWorkerInputEnvelope({ inputPath, expectedInputDigest }) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    throw contractError('experiment_worker_input_invalid', 'input envelope path must be absolute');
  }
  if (typeof expectedInputDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedInputDigest)) {
    throw contractError('experiment_worker_input_invalid', 'expected input digest is invalid');
  }
  const bytes = readFileExact(inputPath, 'worker input envelope', {
    trustedRoot: path.dirname(inputPath),
    maxBytes: 1024 * 1024,
  });
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
    throw contractError('experiment_worker_input_invalid', 'worker input envelope is not JSON');
  }
  const input = verifyWorkerInput(parsed);
  const canonicalBytes = Buffer.from(`${canonicalJson(input)}\n`, 'utf8');
  if (!bytes.equals(canonicalBytes)) {
    throw contractError(
      'experiment_worker_input_invalid',
      'worker input envelope bytes are non-canonical or ambiguous',
    );
  }
  if (input.inputDigest !== expectedInputDigest) {
    throw contractError('experiment_worker_input_digest_mismatch', 'worker input differs from expected digest');
  }
  return input;
}

function parentManifestKind(manifest, parentId) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.id !== parentId) {
    throw contractError('parent_closure_mismatch', 'parent manifest id does not match its pathname');
  }
  if (manifest.schema === 'ugc.experiment-worker-result.v1') return 'typed';
  // Historical experiment manifests predate the signed RESULT schema. They
  // are admitted only as exact server-owned artifact bytes: the signed worker
  // input binds their manifest/patch/html/cover digests and baseline identity.
  // An unknown schema is never treated as legacy, and legacy bytes cannot
  // impersonate a partially typed RESULT.
  if (manifest.schema === undefined && manifest.resultDigest === undefined
    && manifest.inputDigest === undefined && manifest.artifact === undefined) {
    return 'server_bound_legacy';
  }
  throw contractError('parent_closure_mismatch', 'parent manifest schema is not an accepted parent format');
}

// Full parent closure: a typed result or an exact server-bound legacy
// manifest is captured once, and patch/html/cover bytes must replay the
// server-owned artifact identity. The returned patch bytes are the ONLY bytes
// a caller may apply. Legacy admission does not create or inherit a verdict;
// the new candidate still emits the current typed RESULT and reruns every gate.
export function loadParentClosure({ localRoot, artifactRoot, expectedArtifact }) {
  const parentId = expectedArtifact?.experimentId;
  if (typeof parentId !== 'string') {
    throw contractError('parent_unverifiable', 'server-owned parent artifact is required');
  }
  const manifestBytes = readFileExact(
    path.join(localRoot, `${parentId}.json`),
    'parent manifest',
    { trustedRoot: localRoot, maxBytes: 512 * 1024 },
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw contractError('parent_unverifiable', 'parent manifest is not JSON');
  }
  if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))) {
    throw contractError('parent_closure_mismatch', 'parent manifest serialization is non-canonical');
  }
  if (sha256Hex(manifestBytes) !== expectedArtifact.manifestSha256) {
    throw contractError('parent_closure_mismatch', 'parent manifest differs from server-owned evidence');
  }
  const manifestKind = parentManifestKind(manifest, parentId);
  const patchBytes = readFileExact(
    path.join(localRoot, `${parentId}.patch`),
    'parent patch',
    { trustedRoot: localRoot, maxBytes: 4 * 1024 * 1024 },
  );
  const htmlBytes = readFileExact(
    path.join(artifactRoot, `${parentId}.html`),
    'parent artifact html',
    { trustedRoot: artifactRoot, maxBytes: 32 * 1024 * 1024 },
  );
  const coverBytes = readFileExact(
    path.join(artifactRoot, `${parentId}.cover.png`),
    'parent cover',
    { trustedRoot: artifactRoot, maxBytes: 8 * 1024 * 1024 },
  );
  const observed = {
    patchSha256: sha256Hex(patchBytes),
    htmlSha256: sha256Hex(htmlBytes),
    coverSha256: sha256Hex(coverBytes),
  };
  for (const [key, digest] of Object.entries(observed)) {
    if (expectedArtifact[key] !== digest
      || (manifestKind === 'typed' && manifest.artifact?.[key] !== digest)) {
      throw contractError(
        'parent_closure_mismatch',
        `parent ${key} does not replay the captured bytes`,
      );
    }
  }
  if (manifest.baselineId !== expectedArtifact.baselineId
    || manifest.baseCommit !== expectedArtifact.baseCommit
    || manifest.baselineTree !== expectedArtifact.baselineTree) {
    throw contractError('parent_closure_mismatch', 'parent manifest baseline differs from server evidence');
  }
  return {
    manifest,
    patchBytes,
  };
}

function commitFile(stagedPath, finalPath, label, { stagedRoot, finalRoot }) {
  try {
    linkSync(stagedPath, finalPath);
    return 'created';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // The winning process may unlink its staging hard-link immediately after
  // committing the manifest. That changes only ctime/link-count on the shared
  // inode, not the committed bytes. Keep readFileExact strict and retry this
  // one known publication race until the final pathname reaches a stable
  // state; any persistent mutation still fails closed.
  let existing;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      existing = readFileExact(finalPath, label, { trustedRoot: finalRoot });
      break;
    } catch (error) {
      if (error?.code !== 'parent_changed' || attempt === 19) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  const staged = readFileExact(stagedPath, `${label} (staged)`, { trustedRoot: stagedRoot });
  if (sha256Hex(existing) !== sha256Hex(staged)) {
    throw contractError(
      'publish_conflict',
      `${label} already exists with different bytes; committed evidence is append-only`,
    );
  }
  return 'replayed';
}

// Append-only publication. Fields must already be complete except artifact:
// this module derives artifact identity from the exact bytes it persists, so
// the on-disk closure and the typed RESULT can never disagree.
export function publishExperimentResult({
  localRoot,
  artifactRoot,
  input,
  fields,
  html,
  coverPng,
  patch,
}) {
  const verifiedInput = verifyWorkerInput(input);
  const artifact = {
    baseCommit: verifiedInput.baseline.sourceCommit,
    baselineId: verifiedInput.baseline.id,
    baselineTree: verifiedInput.baseline.sourceTree,
    htmlSha256: sha256Hex(html),
    coverSha256: sha256Hex(coverPng),
    patchSha256: sha256Hex(patch),
  };
  const result = buildWorkerResult({
    ...fields,
    coverBytes: Buffer.byteLength(coverPng),
    artifact,
  }, verifiedInput);
  const id = result.id;
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  assertTrustedRoot(localRoot, 'local experiment');
  assertTrustedRoot(artifactRoot, 'experiment artifact');
  const trustedLocalRoot = path.resolve(localRoot);
  const trustedArtifactRoot = path.resolve(artifactRoot);
  const staging = mkdtempSync(path.join(localRoot, '.staging-'));
  try {
    const staged = {
      html: path.join(staging, 'artifact.html'),
      cover: path.join(staging, 'cover.png'),
      patch: path.join(staging, 'experiment.patch'),
      manifest: path.join(staging, 'manifest.json'),
    };
    writeFileSync(staged.html, html);
    writeFileSync(staged.cover, coverPng);
    writeFileSync(staged.patch, patch);
    writeFileSync(staged.manifest, `${JSON.stringify(result, null, 2)}\n`);

    // Fixed order with the manifest last: a crash leaves either no marker
    // (retryable partial that only identical bytes may resume) or a fully
    // committed immutable candidate.
    const roots = { stagedRoot: staging, finalRoot: trustedArtifactRoot };
    commitFile(staged.html, path.join(artifactRoot, `${id}.html`), 'experiment html', roots);
    commitFile(staged.cover, path.join(artifactRoot, `${id}.cover.png`), 'experiment cover', roots);
    commitFile(
      staged.patch,
      path.join(localRoot, `${id}.patch`),
      'experiment patch',
      { stagedRoot: staging, finalRoot: trustedLocalRoot },
    );
    const marker = commitFile(
      staged.manifest,
      path.join(localRoot, `${id}.json`),
      'experiment manifest',
      { stagedRoot: staging, finalRoot: trustedLocalRoot },
    );
    if (marker === 'replayed') {
      const committedBytes = readFileExact(
        path.join(localRoot, `${id}.json`),
        'committed manifest',
        { trustedRoot: trustedLocalRoot, maxBytes: 512 * 1024 },
      );
      const committed = JSON.parse(committedBytes.toString('utf8'));
      if (!committedBytes.equals(Buffer.from(`${JSON.stringify(committed, null, 2)}\n`, 'utf8'))) {
        throw contractError('publish_conflict', 'committed manifest bytes are non-canonical');
      }
      verifyWorkerResult(committed, input);
      return { result: committed, replayed: true };
    }
    return { result, replayed: false };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
