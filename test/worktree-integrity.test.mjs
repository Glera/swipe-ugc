import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
import {
  assertCapturedPatchReplay,
  createSealedGateClone,
} from '../worker/sealed-gate-clone.mjs';

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

test('worker composes integrity and subscription checks without weakening the frozen wire', () => {
  const source = readFileSync(new URL('../worker/experiment-rework.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('await assertWorktreeIntegrity(worktree, integrity)'));
  assert.ok(source.includes('await assertSubscriptionAuth()'));
  assert.ok(source.indexOf('await assertSubscriptionAuth()') < source.indexOf('await invokeAgent('));
  assert.ok(source.includes("new Set(['input-digest', 'input-envelope'])"));
  assert.ok(!source.includes('UGC_EXPERIMENT_CONTEXT_FILE'));
  assert.ok(!source.includes('MAX_ATTEMPTS'));
  assert.equal((source.match(/await invokeAgent\(/g) || []).length, 1);
  assert.ok(source.indexOf('const validated = await validateDiff(worktree')
    < source.indexOf('candidateGateWorktree = mkdtempSync'));
  assert.ok(source.includes('await typecheck(\n    candidateGate.worktree'));
  assert.ok(source.includes('await build(candidateGate.worktree'));
  assert.ok(source.includes('selfContainedArtifact(candidateGate.worktree)'));
  assert.ok(!source.includes('await typecheck(worktree'));
  assert.ok(!source.includes('await build(worktree'));
});

test('sealed gate clone replays captured bytes despite a delayed authoring mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'swipe-sealed-gate-test-'));
  const sourceRepo = path.join(root, 'source');
  const authoring = path.join(root, 'authoring');
  const sealed = path.join(root, 'sealed');
  const dependencies = path.join(sourceRepo, 'node_modules');
  const relative = 'marble-sort-swipe/src/main.ts';
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: options.cwd,
    env: gitEnv,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 1024 * 1024,
  });
  const runGit = async (args, options = {}) => git(args, options);
  try {
    mkdirSync(path.join(sourceRepo, 'marble-sort-swipe', 'src'), { recursive: true });
    writeFileSync(path.join(sourceRepo, relative), 'export const state = "baseline";\n');
    git(['init', '--quiet'], { cwd: sourceRepo });
    git(['config', 'user.email', 'sealed@example.test'], { cwd: sourceRepo });
    git(['config', 'user.name', 'Sealed Test'], { cwd: sourceRepo });
    git(['add', '--', relative], { cwd: sourceRepo });
    git(['commit', '--quiet', '-m', 'baseline'], { cwd: sourceRepo });
    mkdirSync(dependencies);
    writeFileSync(path.join(dependencies, '.proof'), 'trusted dependencies\n');
    const baseCommit = git(['rev-parse', 'HEAD'], { cwd: sourceRepo }).trim();
    const sourceTree = git(['rev-parse', `${baseCommit}:marble-sort-swipe`], { cwd: sourceRepo }).trim();
    git(['clone', '--quiet', '--no-hardlinks', sourceRepo, authoring], { cwd: root });
    const authoringFile = path.join(authoring, relative);
    writeFileSync(authoringFile, 'export const state = "captured";\n');
    const capturedPatch = Buffer.from(git([
      'diff', '--no-ext-diff', '--binary', '--', 'marble-sort-swipe/src',
    ], { cwd: authoring }), 'utf8');

    const delayedMutation = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '-e',
        'setTimeout(() => require("fs").writeFileSync(process.argv[1], "export const state = \\"late\\";\\n"), 10)',
        authoringFile,
      ], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mutation exited ${code}`)));
    });

    await createSealedGateClone({
      sourceRepo,
      destination: sealed,
      baseCommit,
      sourcePath: 'marble-sort-swipe',
      sourceTree,
      patchBytes: capturedPatch,
      dependencies,
      runGit,
      normalizeIndexFlags: async () => undefined,
    });
    await delayedMutation;
    const replayedPatch = Buffer.from(git([
      'diff', '--no-ext-diff', '--binary', '--', 'marble-sort-swipe/src',
    ], { cwd: sealed }), 'utf8');
    assert.doesNotThrow(() => assertCapturedPatchReplay(capturedPatch, replayedPatch));
    assert.equal(readFileSync(path.join(sealed, relative), 'utf8'), 'export const state = "captured";\n');
    assert.equal(readFileSync(authoringFile, 'utf8'), 'export const state = "late";\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
