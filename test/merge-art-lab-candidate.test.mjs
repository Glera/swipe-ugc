import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMergeArtLabCandidate,
  publishMergeArtLabCandidate,
} from '../recipes/merge/art-v1/lab-candidate.mjs';
import { sha256Hex } from '../worker/result-contract.mjs';

function fixture(root) {
  const artifactRoot = path.join(root, 'artifact');
  const runtime = path.join(artifactRoot, 'runtime');
  const qa = path.join(artifactRoot, 'qa');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(qa, { recursive: true });
  const index = Buffer.from('<!doctype html><script type="module" src="./payload.js"></script>');
  const payload = Buffer.from('globalThis.__candidateMounted=true;');
  const patch = Buffer.from('diff --git a/a b/a\n');
  const pack = 'a'.repeat(64);
  const runtimeDigest = `sha256:${'b'.repeat(64)}`;
  const artifact = {
    schema: 'merge.art-runtime-artifact.v1',
    artPackHash: pack,
    compilerDigest: 'c'.repeat(64),
    templateContractDigest: 'd'.repeat(64),
    providerPolicyDigest: 'e'.repeat(64),
    budgetReceipt: { provider: 'openai.builtin-imagegen.v1', calls: 9, marginalCostMicros: 0, priceKnown: true },
    runtimeArtifactDigest: runtimeDigest,
    adapterPatchSha256: sha256Hex(patch).slice(7),
    source: {
      commit: '1'.repeat(40), tree: '2'.repeat(40), playablePath: 'merge-locked-v1-swipe',
    },
    world: { worldId: 'test-world', title: 'Test World', visualThesis: 'Distinct world', palette: ['#000000'], promptProfile: 'blind' },
    runtimeFiles: [
      { path: 'index.html', bytes: index.length, sha256: sha256Hex(index) },
      { path: 'payload.js', bytes: payload.length, sha256: sha256Hex(payload) },
    ],
  };
  const performance = { frames: 239, medianFrameMs: 8.3, p95FrameMs: 9, longFrameRatio: 0 };
  const run = { completedCycle: true, gameplayEvents: [{ type: 'progress' }], performance };
  const report = {
    schema: 'merge.art-qa-report.v1', artPackHash: pack, runtimeArtifactDigest: runtimeDigest,
    gameplayTerminalTraceEqual: true,
    runs: { baseline: run, candidatePortrait: run, candidateLandscape: run },
  };
  writeFileSync(path.join(runtime, 'index.html'), index);
  writeFileSync(path.join(runtime, 'payload.js'), payload);
  writeFileSync(path.join(artifactRoot, 'trusted-adapter.patch'), patch);
  writeFileSync(path.join(artifactRoot, 'merge-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(path.join(qa, 'qa-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(qa, 'test-world-portrait.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  return { artifactRoot, qa, report };
}

test('publishes one exact self-contained blind-review candidate with a manifest-last replay', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-art-candidate-'));
  try {
    const value = fixture(root);
    const built = buildMergeArtLabCandidate({ artifactRoot: value.artifactRoot });
    assert.equal(built.id, `merge-art-test-world-${'a'.repeat(12)}-${'c'.repeat(12)}`);
    assert.doesNotMatch(built.html.toString('utf8'), /src="\.\/payload\.js"/);
    assert.match(built.html.toString('utf8'), /atob\('/);
    const ugcRoot = path.join(root, 'ugc');
    const first = publishMergeArtLabCandidate({ artifactRoot: value.artifactRoot, ugcRoot });
    const replay = publishMergeArtLabCandidate({ artifactRoot: value.artifactRoot, ugcRoot });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    const committed = JSON.parse(readFileSync(path.join(ugcRoot, '.local-experiments', `${first.id}.json`), 'utf8'));
    assert.equal(committed.schema, 'merge.art-lab-candidate.v1');
    assert.equal(committed.qa.gameplayTraceEqual, true);
    assert.equal(committed.htmlSha256, sha256Hex(readFileSync(path.join(ugcRoot, 'u', 'local-experiments', `${first.id}.html`))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a performance claim outside the frozen QA budget', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-art-candidate-bad-'));
  try {
    const value = fixture(root);
    value.report.runs.candidatePortrait.performance.p95FrameMs = 51;
    writeFileSync(path.join(value.qa, 'qa-report.json'), `${JSON.stringify(value.report, null, 2)}\n`);
    assert.throws(
      () => buildMergeArtLabCandidate({ artifactRoot: value.artifactRoot }),
      (error) => error?.code === 'merge_art_lab_candidate_invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
