import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadParentClosure,
  loadWorkerInputEnvelope,
  publishExperimentResult,
  readFileExact,
} from '../worker/publish-local.mjs';
import {
  assertPublishableWin,
  canonicalJson,
  sha256Hex,
  verifyWorkerFailure,
  verifyWorkerResult,
} from '../worker/result-contract.mjs';
import { pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The wire golden (and in the publication tests, the terminal parser) are
// owned by the private swipe-generator repo. Standalone CI cannot check it
// out, so these cross-repo contract tests run wherever the two repos sit side
// by side: developer machines and the generator-side CI, which checkouts the
// public swipe-ugc at a pinned ref. Skip honestly instead of crashing at
// import time.
const SIBLING_GENERATOR = path.resolve(here, '..', '..', 'swipe-generator');
const SIBLING_SKIP = existsSync(SIBLING_GENERATOR)
  ? false
  : 'sibling swipe-generator absent (private repo, not checked out in standalone CI)';
const t = (name, fn) => test(name, { skip: SIBLING_SKIP }, fn);
const { parseExperimentWorkerTerminal } = SIBLING_SKIP
  ? { parseExperimentWorkerTerminal: null }
  : await import(pathToFileURL(path.join(
    SIBLING_GENERATOR, 'src', 'experiment-worker-evidence.mjs',
  )).href);

const workerScript = path.join(here, '..', 'worker', 'experiment-rework.mjs');
const golden = SIBLING_SKIP ? null : JSON.parse(readFileSync(path.resolve(
  here, '..', '..', 'swipe-generator', 'test', 'fixtures',
  'experiment-worker-wire-v1.golden.json',
), 'utf8'));

function tempRoots() {
  const base = mkdtempSync(path.join(tmpdir(), 'worker-publication-'));
  return {
    base,
    localRoot: path.join(base, 'local'),
    artifactRoot: path.join(base, 'artifacts'),
  };
}

function candidate({ suffix = '' } = {}) {
  const { feedback: _feedback, ...concept } = golden.result.concept;
  return {
    input: golden.input,
    fields: {
      title: golden.result.title,
      concept,
      autoplayPassed: true,
      autoplayOutcome: { budgetSeconds: 150, outcome: 'win', proven: true, reason: 'win_proven', runs: 1 },
      wallTimeMs: 1000,
      agentInvocations: 1,
      playtestRuns: 1,
      conformance: { idleMs: 30000, rafFrames: 1800 },
      autoplay: { durationMs: 15000, rafFrames: 900, runNumber: 1, visualStates: 4 },
      files: ['marble-sort-swipe/src/main.ts'],
      agentSummary: 'fixture summary',
      createdAt: '2026-07-16T00:00:00.000Z',
      coverBytes: 999,
    },
    html: `<html data-suffix="${suffix}"/>`,
    coverPng: Buffer.from([1, 2, suffix ? 9 : 3]),
    patch: `diff --git a b\n+fixture ${suffix}\n`,
  };
}

// A runtime-safe rework candidate whose fixed-seed autoplay exhausted its budget
// without a WIN: a complete, honestly-marked RESULT with no win metrics.
function unprovenCandidate({ suffix = 'unproven', outcome = 'terminal_loss' } = {}) {
  const item = candidate({ suffix });
  item.fields.autoplayPassed = false;
  item.fields.autoplayOutcome = { budgetSeconds: 150, outcome, proven: false, reason: 'win_not_proven', runs: 2 };
  item.fields.playtestRuns = 2;
  item.fields.autoplay = null;
  return item;
}

function expectedArtifact(result, localRoot) {
  return {
    schema: 'lab.experiment-artifact-identity.v1',
    experimentId: result.id,
    baselineId: result.baselineId,
    baseCommit: result.baseCommit,
    baselineTree: result.baselineTree,
    manifestSha256: sha256Hex(readFileSync(path.join(localRoot, `${result.id}.json`))),
    patchSha256: result.artifact.patchSha256,
    htmlSha256: result.artifact.htmlSha256,
    coverSha256: result.artifact.coverSha256,
  };
}

t('publication is append-only with identical replay and typed conflict', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const first = publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
    assert.equal(first.replayed, false);
    assert.equal(first.result.coverBytes, candidate().coverPng.length);
    assert.equal(
      readFileSync(path.join(localRoot, `${first.result.id}.json`), 'utf8'),
      `${JSON.stringify(first.result, null, 2)}\n`,
    );
    const replay = publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.resultDigest, first.result.resultDigest);

    const conflicting = candidate();
    conflicting.html = '<html data-forged="true"/>';
    assert.throws(
      () => publishExperimentResult({ localRoot, artifactRoot, ...conflicting }),
      (error) => error.code === 'publish_conflict',
    );
    assert.equal(
      sha256Hex(readFileSync(path.join(artifactRoot, `${first.result.id}.html`))),
      first.result.artifact.htmlSha256,
    );
    assert.equal(readdirSync(localRoot).filter((name) => name.startsWith('.staging-')).length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t('parent closure is server-evidence-bound and refuses swapped pathnames', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const parent = publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
    const evidence = expectedArtifact(parent.result, localRoot);
    const closure = loadParentClosure({ localRoot, artifactRoot, expectedArtifact: evidence });
    assert.equal(sha256Hex(closure.patchBytes), evidence.patchSha256);

    const patchPath = path.join(localRoot, `${parent.result.id}.patch`);
    const lure = path.join(base, 'lure.patch');
    writeFileSync(lure, 'diff --git a b\n+swapped\n');
    rmSync(patchPath);
    symlinkSync(lure, patchPath);
    assert.throws(
      () => loadParentClosure({ localRoot, artifactRoot, expectedArtifact: evidence }),
      (error) => error.code === 'parent_unverifiable',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t('server-owned artifact evidence admits an exact legacy parent without treating it as a typed RESULT', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    const id = 'legacy-parent-1234';
    const patchBytes = Buffer.from('diff --git a/marble-sort-swipe/src/main.ts b/marble-sort-swipe/src/main.ts\n+legacy parent\n');
    const htmlBytes = Buffer.from('<!doctype html><title>legacy parent</title>');
    const coverBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const manifest = {
      id,
      parentId: null,
      baselineId: golden.input.baseline.id,
      baselineTree: golden.input.baseline.sourceTree,
      provider: 'claude',
      baseCommit: golden.input.baseline.sourceCommit,
      title: 'Legacy reviewed parent',
      autoplayPassed: true,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(localRoot, `${id}.json`), manifestBytes);
    writeFileSync(path.join(localRoot, `${id}.patch`), patchBytes);
    writeFileSync(path.join(artifactRoot, `${id}.html`), htmlBytes);
    writeFileSync(path.join(artifactRoot, `${id}.cover.png`), coverBytes);
    const expectedArtifact = {
      schema: 'lab.experiment-artifact-identity.v1',
      experimentId: id,
      baselineId: manifest.baselineId,
      baseCommit: manifest.baseCommit,
      baselineTree: manifest.baselineTree,
      manifestSha256: sha256Hex(manifestBytes),
      patchSha256: sha256Hex(patchBytes),
      htmlSha256: sha256Hex(htmlBytes),
      coverSha256: sha256Hex(coverBytes),
    };

    const closure = loadParentClosure({ localRoot, artifactRoot, expectedArtifact });
    assert.deepEqual(closure.manifest, manifest);
    assert.deepEqual(closure.patchBytes, patchBytes);

    const unknown = { ...manifest, schema: 'ugc.untrusted-parent.v1' };
    const unknownBytes = Buffer.from(`${JSON.stringify(unknown, null, 2)}\n`);
    writeFileSync(path.join(localRoot, `${id}.json`), unknownBytes);
    assert.throws(
      () => loadParentClosure({
        localRoot,
        artifactRoot,
        expectedArtifact: { ...expectedArtifact, manifestSha256: sha256Hex(unknownBytes) },
      }),
      (error) => error.code === 'parent_closure_mismatch',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t('input envelope requires one canonical no-duplicate-key byte representation', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'worker-envelope-'));
  try {
    const root = path.join(base, 'root');
    mkdirSync(root);
    const inputPath = path.join(root, 'input.json');
    const canonical = `${canonicalJson(golden.input)}\n`;
    writeFileSync(inputPath, canonical);
    assert.deepEqual(loadWorkerInputEnvelope({
      inputPath,
      expectedInputDigest: golden.input.inputDigest,
    }), golden.input);
    assert.throws(() => loadWorkerInputEnvelope({
      inputPath,
      expectedInputDigest: `sha256:${'0'.repeat(64)}`,
    }), /expected digest/);

    writeFileSync(inputPath, `${JSON.stringify(golden.input)}\n`);
    assert.throws(
      () => loadWorkerInputEnvelope({ inputPath, expectedInputDigest: golden.input.inputDigest }),
      /non-canonical or ambiguous/,
    );
    writeFileSync(inputPath, canonical.replace('{', '{"schema":"forged",'));
    assert.throws(
      () => loadWorkerInputEnvelope({ inputPath, expectedInputDigest: golden.input.inputDigest }),
      /non-canonical or ambiguous/,
    );

    writeFileSync(inputPath, canonical);

    const nested = path.join(root, 'nested');
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'input.json'), '{}');
    symlinkSync(real, nested, 'dir');
    assert.throws(
      () => readFileExact(path.join(nested, 'input.json'), 'symlinked envelope', { trustedRoot: root }),
      (error) => error.code === 'parent_unverifiable',
    );

    assert.throws(
      () => readFileExact(inputPath, 'swapped envelope', {
        trustedRoot: root,
        afterRead: ({ file }) => {
          const replacement = path.join(root, 'replacement.json');
          writeFileSync(replacement, `${JSON.stringify(golden.input)}\n`);
          renameSync(replacement, file);
        },
      }),
      (error) => error.code === 'parent_changed',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t('real interprocess race commits one immutable candidate', async () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  const script = path.join(base, 'publish-once.mjs');
  writeFileSync(script, [
    `import { publishExperimentResult } from ${JSON.stringify(path.join(here, '..', 'worker', 'publish-local.mjs'))};`,
    'const payload = JSON.parse(process.argv[2]);',
    'const outcome = publishExperimentResult({',
    '  localRoot: payload.localRoot, artifactRoot: payload.artifactRoot,',
    '  input: payload.input, fields: payload.fields, html: payload.html,',
    '  coverPng: Buffer.from(payload.cover), patch: payload.patch,',
    '});',
    'console.log(JSON.stringify({ digest: outcome.result.resultDigest, replayed: outcome.replayed }));',
  ].join('\n'));
  try {
    const item = candidate();
    const payload = {
      localRoot,
      artifactRoot,
      input: item.input,
      fields: item.fields,
      html: item.html,
      cover: [...item.coverPng],
      patch: item.patch,
    };
    const { spawn } = await import('node:child_process');
    const runs = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))));
    })));
    assert.equal(new Set(runs.map((item) => item.digest)).size, 1);
    assert.equal(readdirSync(localRoot).filter((name) => name.endsWith('.json')).length, 1);
    assert.equal(readdirSync(localRoot).filter((name) => name.startsWith('.staging-')).length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t('a marked-unproven candidate is a complete append-only RESULT with no win metrics', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const published = publishExperimentResult({ localRoot, artifactRoot, ...unprovenCandidate() });
    assert.equal(published.replayed, false);
    assert.equal(published.result.autoplayPassed, false);
    assert.deepEqual(published.result.autoplayOutcome, {
      budgetSeconds: 150, outcome: 'terminal_loss', proven: false, reason: 'win_not_proven', runs: 2,
    });
    assert.equal(published.result.autoplay, null);
    assert.equal(published.result.playtestRuns, 2);
    // The committed manifest re-verifies in full: unproven is a first-class RESULT.
    assert.deepEqual(verifyWorkerResult(published.result, golden.input), published.result);
    const replay = publishExperimentResult({ localRoot, artifactRoot, ...unprovenCandidate() });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.resultDigest, published.result.resultDigest);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t('publication is strictly WIN-only and rejects an unproven candidate with a typed cause', () => {
  const { base, localRoot, artifactRoot } = tempRoots();
  try {
    const proven = publishExperimentResult({ localRoot, artifactRoot, ...candidate() });
    assert.equal(assertPublishableWin(proven.result), proven.result);

    const unproven = publishExperimentResult({ localRoot, artifactRoot, ...unprovenCandidate() });
    assert.throws(
      () => assertPublishableWin(unproven.result),
      (error) => error.code === 'experiment_publish_unproven',
    );
    // A forged proven flag without matching win metrics also fails closed.
    assert.throws(
      () => assertPublishableWin({ ...unproven.result, autoplayPassed: true }),
      (error) => error.code === 'experiment_publish_unproven',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function runWorker(argv) {
  return spawnSync(process.execPath, [workerScript, ...argv], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    timeout: 30000,
  });
}

t('command emits bound typed ERROR on stdout accepted by the generator parser', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'worker-command-'));
  const repoLocal = path.join(here, '..', '.local-experiments');
  const before = existsSync(repoLocal) ? readdirSync(repoLocal).sort() : null;
  try {
    const inputPath = path.join(base, 'input.json');
    writeFileSync(inputPath, `${canonicalJson(golden.input)}\n`);
    const result = runWorker([
      '--input-envelope', inputPath,
      '--input-digest', golden.input.inputDigest,
    ]);
    assert.equal(result.status, 1);
    const line = result.stdout.split('\n').find((item) => item.startsWith('ERROR '));
    const failure = JSON.parse(line.slice('ERROR '.length));
    assert.deepEqual(verifyWorkerFailure(failure, golden.input), failure);
    assert.equal(line, `ERROR ${JSON.stringify(failure)}`);
    assert.equal(failure.code, 'parent_unverifiable');
    assert.deepEqual(parseExperimentWorkerTerminal({
      stdout: result.stdout,
      exitCode: result.status,
      input: golden.input,
    }), { kind: 'failure', value: failure });
    assert.ok(!/\n\s+at /.test(result.stderr));

    const foreign = runWorker([
      '--input-envelope', inputPath,
      '--input-digest', golden.input.inputDigest,
      '--provider', 'codex',
    ]);
    assert.equal(foreign.status, 1);
    assert.match(foreign.stdout, /parallel CLI authority is forbidden/);
    const after = existsSync(repoLocal) ? readdirSync(repoLocal).sort() : null;
    assert.deepEqual(after, before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
