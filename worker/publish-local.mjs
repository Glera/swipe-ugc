// Hardened local persistence for the exact experiment-worker contract.
//
// Reads never follow symlinks and capture bytes exactly once (no pathname
// re-open between hash and use). Publication is append-only and race-safe:
// artifacts are staged, then committed with no-overwrite links in a fixed
// order with the manifest as the last commit marker; an existing candidate
// is either an identical replay or a typed conflict — never an overwrite.
import { closeSync, constants, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

import {
  buildWorkerResult,
  contractError,
  sha256Hex,
  verifyWorkerResult,
} from './result-contract.mjs';

const MAX_READ_BYTES = 64 * 1024 * 1024;

// Single hardened read: O_NOFOLLOW rejects symlinked pathnames, fstat pins
// the opened inode to a bounded regular file, and every later consumer uses
// these captured bytes instead of re-opening the pathname.
export function readFileExact(pathname, label) {
  let descriptor;
  try {
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw contractError(
      'parent_unverifiable',
      `${label} is unreadable without following links: ${error.code || error.message}`,
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw contractError('parent_unverifiable', `${label} is not a regular file`);
    if (stat.size > MAX_READ_BYTES) throw contractError('parent_unverifiable', `${label} exceeds the read bound`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// Full parent closure: the manifest must be a verified typed result and the
// captured patch/html/cover bytes must replay its artifact identity. The
// returned patch bytes are the ONLY bytes a caller may apply.
export function loadParentClosure({ localRoot, artifactRoot, parentId }) {
  const manifestBytes = readFileExact(path.join(localRoot, `${parentId}.json`), 'parent manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw contractError('parent_unverifiable', 'parent manifest is not JSON');
  }
  if (manifest?.schema !== 'ugc.experiment-worker-result.v1') {
    throw contractError(
      'legacy_parent_unverifiable',
      'parent predates the typed worker contract and cannot anchor an exact tuning pass',
    );
  }
  verifyWorkerResult(manifest);
  if (manifest.id !== parentId) {
    throw contractError('parent_closure_mismatch', 'parent manifest id does not match its pathname');
  }
  const patchBytes = readFileExact(path.join(localRoot, `${parentId}.patch`), 'parent patch');
  const htmlBytes = readFileExact(path.join(artifactRoot, `${parentId}.html`), 'parent artifact html');
  const coverBytes = readFileExact(path.join(artifactRoot, `${parentId}.cover.png`), 'parent cover');
  const observed = {
    patchSha256: sha256Hex(patchBytes),
    htmlSha256: sha256Hex(htmlBytes),
    coverSha256: sha256Hex(coverBytes),
  };
  for (const [key, digest] of Object.entries(observed)) {
    if (manifest.artifact[key] !== digest) {
      throw contractError(
        'parent_closure_mismatch',
        `parent ${key} does not replay the captured bytes`,
      );
    }
  }
  return {
    manifest,
    patchBytes,
    binding: { experimentId: parentId, patchSha256: observed.patchSha256 },
  };
}

function commitFile(stagedPath, finalPath, label) {
  try {
    linkSync(stagedPath, finalPath);
    return 'created';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const existing = readFileExact(finalPath, label);
  const staged = readFileExact(stagedPath, `${label} (staged)`);
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
  fields,
  html,
  coverPng,
  patch,
}) {
  const artifact = {
    baseCommit: fields.baseCommit,
    baselineId: fields.baselineId,
    htmlSha256: sha256Hex(html),
    coverSha256: sha256Hex(coverPng),
    patchSha256: sha256Hex(patch),
  };
  const result = buildWorkerResult({ ...fields, artifact });
  const id = result.id;
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
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
    commitFile(staged.html, path.join(artifactRoot, `${id}.html`), 'experiment html');
    commitFile(staged.cover, path.join(artifactRoot, `${id}.cover.png`), 'experiment cover');
    commitFile(staged.patch, path.join(localRoot, `${id}.patch`), 'experiment patch');
    const marker = commitFile(staged.manifest, path.join(localRoot, `${id}.json`), 'experiment manifest');
    if (marker === 'replayed') {
      const committed = JSON.parse(
        readFileExact(path.join(localRoot, `${id}.json`), 'committed manifest').toString('utf8'),
      );
      verifyWorkerResult(committed);
      return { result: committed, replayed: true };
    }
    return { result, replayed: false };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
