import { existsSync, lstatSync, symlinkSync } from 'fs';
import path from 'path';
import {
  assertTrustedDependencyLink,
  captureGitMetadata,
  captureTrustedDependencyTarget,
} from './worktree-integrity.mjs';

function contractError(message) {
  const error = new Error(message);
  error.code = 'sealed_gate_clone_invalid';
  return error;
}

function exactPatchBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw contractError('captured patch must be exact bytes');
}

export function assertCapturedPatchReplay(capturedPatch, replayedPatch) {
  const captured = exactPatchBytes(capturedPatch);
  const replayed = exactPatchBytes(replayedPatch);
  if (!captured.equals(replayed)) {
    throw contractError('sealed clone does not replay the captured patch bytes');
  }
}

/**
 * Create a gate-only clone that has no shared Git object store with the
 * authoring checkout. The model never receives this path. Only captured patch
 * bytes cross from the authoring checkout into this clone.
 */
export async function createSealedGateClone({
  sourceRepo,
  destination,
  baseCommit,
  sourcePath,
  sourceTree,
  patchBytes,
  dependencies,
  runGit,
  normalizeIndexFlags,
}) {
  if (existsSync(destination)) throw contractError('sealed clone destination must not exist');
  if (typeof runGit !== 'function' || typeof normalizeIndexFlags !== 'function') {
    throw contractError('sealed clone requires trusted Git callbacks');
  }
  const captured = exactPatchBytes(patchBytes);
  await runGit([
    'clone', '--no-hardlinks', '--no-checkout', '--', sourceRepo, destination,
  ], {
    cwd: path.dirname(destination),
    timeoutMs: 60000,
  });
  await runGit(['checkout', '--detach', baseCommit], { cwd: destination, timeoutMs: 60000 });
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: destination })).trim();
  const tree = (await runGit(['rev-parse', `${baseCommit}:${sourcePath}`], { cwd: destination })).trim();
  if (head !== baseCommit || tree !== sourceTree) {
    throw contractError('sealed clone differs from the exact baseline commit/tree');
  }
  const alternates = path.join(destination, '.git', 'objects', 'info', 'alternates');
  const alternateStat = lstatSync(alternates, { throwIfNoEntry: false });
  if (alternateStat) throw contractError('sealed clone must not borrow a mutable Git object store');

  const trustedDependencies = captureTrustedDependencyTarget(dependencies);
  symlinkSync(dependencies, path.join(destination, 'node_modules'), 'dir');
  assertTrustedDependencyLink(destination, trustedDependencies);
  await runGit(['apply', '--whitespace=nowarn', '-'], {
    cwd: destination,
    input: captured,
    maxBuffer: 1024 * 1024,
  });
  await normalizeIndexFlags(destination);
  const integrity = {
    git: captureGitMetadata(destination),
    dependencies: trustedDependencies,
  };
  assertTrustedDependencyLink(destination, trustedDependencies);
  return { worktree: destination, integrity, capturedPatch: captured };
}
