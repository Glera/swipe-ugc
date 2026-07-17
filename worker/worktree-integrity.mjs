import { createHash } from 'crypto';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from 'fs';
import path from 'path';

// These are the pieces of repository state that can change what HEAD, status,
// or diff means without leaving an ordinary working-tree change behind.
const PROTECTED_GIT_PATHS = [
  'HEAD',
  'config',
  'config.worktree',
  'index',
  'packed-refs',
  'commondir',
  'shallow',
  'hooks',
  'info',
  'objects/info',
  'refs',
];

function digestEntry(root, relative) {
  const absolute = path.join(root, relative);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return `symlink:${mode}:${readlinkSync(absolute)}`;
  if (stat.isFile()) {
    return `file:${mode}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
  }
  if (stat.isDirectory()) {
    const children = readdirSync(absolute).sort().map((name) => [
      name,
      digestEntry(root, path.join(relative, name)),
    ]);
    return `directory:${mode}:${createHash('sha256').update(JSON.stringify(children)).digest('hex')}`;
  }
  return `special:${mode}:${stat.size}`;
}

function gitDirectory(worktree) {
  const git = path.join(worktree, '.git');
  const stat = lstatSync(git);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('disposable clone .git must remain a real directory');
  }
  return git;
}

export function captureGitMetadata(worktree) {
  const git = gitDirectory(worktree);
  return {
    gitRealpath: realpathSync(git),
    entries: Object.fromEntries(PROTECTED_GIT_PATHS.map((relative) => [relative, digestEntry(git, relative)])),
  };
}

export function assertGitMetadataUnchanged(worktree, snapshot, { excludeIndex = false } = {}) {
  const current = captureGitMetadata(worktree);
  if (current.gitRealpath !== snapshot.gitRealpath) {
    throw new Error('agent replaced or redirected the disposable clone .git directory');
  }
  for (const relative of PROTECTED_GIT_PATHS) {
    if (excludeIndex && relative === 'index') continue;
    if (current.entries[relative] !== snapshot.entries[relative]) {
      throw new Error(`agent changed protected git metadata: .git/${relative}`);
    }
  }
}

export function captureTrustedDependencyTarget(trustedDependencies) {
  const realpath = realpathSync(trustedDependencies);
  const stat = lstatSync(realpath);
  if (!stat.isDirectory()) throw new Error('trusted node_modules target is not a directory');
  return { realpath, device: stat.dev, inode: stat.ino };
}

export function assertTrustedDependencyLink(worktree, trustedDependencies) {
  const trusted = typeof trustedDependencies === 'string'
    ? captureTrustedDependencyTarget(trustedDependencies)
    : trustedDependencies;
  const link = path.join(worktree, 'node_modules');
  let stat;
  try { stat = lstatSync(link); } catch {
    throw new Error('trusted node_modules link is missing from the disposable clone');
  }
  if (!stat.isSymbolicLink()) {
    throw new Error('agent replaced the trusted node_modules symlink');
  }
  let actual;
  try {
    actual = realpathSync(link);
  } catch {
    throw new Error('trusted node_modules symlink no longer resolves');
  }
  if (actual !== trusted.realpath) {
    throw new Error('agent redirected node_modules away from the trusted dependency tree');
  }
  const current = lstatSync(trusted.realpath);
  if (!current.isDirectory()) {
    throw new Error('trusted node_modules target is not a directory');
  }
  if (current.dev !== trusted.device || current.ino !== trusted.inode) {
    throw new Error('trusted node_modules target was replaced during the experiment');
  }
}

export function hiddenIndexFlags(lsFilesVerbose) {
  return String(lsFilesVerbose).split('\0').filter(Boolean).flatMap((entry) => {
    const separator = entry.indexOf(' ');
    if (separator < 1) return [];
    const tag = entry.slice(0, separator);
    const file = entry.slice(separator + 1);
    // `git ls-files -v` lowercases tags for assume-unchanged entries; S is
    // skip-worktree (and s can represent both conditions).
    return tag === 'S' || /^[a-z]$/.test(tag) ? [{ tag, file }] : [];
  });
}

export function indexFlagClearCommands(files, batchSize = 200) {
  const commands = [];
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = files.slice(offset, offset + batchSize);
    // Git 2.17 treats these as separate index actions; combining both options
    // in one invocation leaves skip-worktree set.
    commands.push(['update-index', '--no-assume-unchanged', '--', ...batch]);
    commands.push(['update-index', '--no-skip-worktree', '--', ...batch]);
  }
  return commands;
}
