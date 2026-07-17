import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertGitMetadataUnchanged,
  assertTrustedDependencyLink,
  captureGitMetadata,
  captureTrustedDependencyTarget,
  hiddenIndexFlags,
  indexFlagClearCommands,
} from '../worker/worktree-integrity.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'swipe-integrity-test-'));
  const worktree = path.join(root, 'worktree');
  const dependencies = path.join(root, 'dependencies');
  mkdirSync(path.join(worktree, '.git', 'hooks'), { recursive: true });
  mkdirSync(path.join(worktree, '.git', 'info'), { recursive: true });
  mkdirSync(path.join(worktree, '.git', 'objects', 'info'), { recursive: true });
  mkdirSync(path.join(worktree, '.git', 'refs'), { recursive: true });
  mkdirSync(dependencies);
  writeFileSync(path.join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(worktree, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(path.join(worktree, '.git', 'index'), 'trusted-index');
  symlinkSync(dependencies, path.join(worktree, 'node_modules'), 'dir');
  return { root, worktree, dependencies };
}

test('protected git metadata detects index, config, HEAD, and hook changes', () => {
  for (const relative of ['index', 'config', 'HEAD', 'hooks/evil']) {
    const { root, worktree } = fixture();
    try {
      const snapshot = captureGitMetadata(worktree);
      writeFileSync(path.join(worktree, '.git', relative), 'tampered');
      assert.throws(() => assertGitMetadataUnchanged(worktree, snapshot), /protected git metadata/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('trusted dependency link rejects replacement and redirection', () => {
  const { root, worktree, dependencies } = fixture();
  try {
    assert.doesNotThrow(() => assertTrustedDependencyLink(worktree, dependencies));
    unlinkSync(path.join(worktree, 'node_modules'));
    mkdirSync(path.join(worktree, 'node_modules'));
    assert.throws(() => assertTrustedDependencyLink(worktree, dependencies), /replaced.*symlink/);
    rmSync(path.join(worktree, 'node_modules'), { recursive: true });
    const other = path.join(root, 'other');
    mkdirSync(other);
    symlinkSync(other, path.join(worktree, 'node_modules'), 'dir');
    assert.throws(() => assertTrustedDependencyLink(worktree, dependencies), /redirected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted dependency identity detects replacement at the same path', () => {
  const { root, worktree, dependencies } = fixture();
  try {
    const trusted = captureTrustedDependencyTarget(dependencies);
    renameSync(dependencies, `${dependencies}-old`);
    mkdirSync(dependencies);
    assert.throws(() => assertTrustedDependencyLink(worktree, trusted), /target was replaced/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hidden index flags recognizes assume-unchanged and skip-worktree tags', () => {
  assert.deepEqual(hiddenIndexFlags('H normal.ts\0h assumed.ts\0S skipped.ts\0s both.ts\0'), [
    { tag: 'h', file: 'assumed.ts' },
    { tag: 'S', file: 'skipped.ts' },
    { tag: 's', file: 'both.ts' },
  ]);
});

test('index flags are cleared in separate Git actions', () => {
  assert.deepEqual(indexFlagClearCommands(['a.ts', 'b.ts']), [
    ['update-index', '--no-assume-unchanged', '--', 'a.ts', 'b.ts'],
    ['update-index', '--no-skip-worktree', '--', 'a.ts', 'b.ts'],
  ]);
});
