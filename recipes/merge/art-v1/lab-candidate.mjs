import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { commitFile, readFileExact } from '../../../worker/publish-local.mjs';
import { sha256Hex } from '../../../worker/result-contract.mjs';

const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORLD_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;

function candidateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw candidateError('merge_art_lab_candidate_invalid', `${label} is not JSON`); }
}

function fileEntry(manifest, name) {
  const entry = manifest.runtimeFiles?.find((value) => value?.path === name);
  if (!entry || !Number.isInteger(entry.bytes) || entry.bytes < 1 || !DIGEST.test(String(entry.sha256 || ''))) {
    throw candidateError('merge_art_lab_candidate_invalid', `${name} is absent from the runtime closure`);
  }
  return entry;
}

function assertFileEntry(bytes, entry, label) {
  if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
    throw candidateError('merge_art_lab_candidate_invalid', `${label} differs from the runtime closure`);
  }
}

function inlinePayload(indexHtml, payload) {
  const marker = '<script type="module" src="./payload.js"></script>';
  const first = indexHtml.indexOf(marker);
  if (first < 0 || indexHtml.indexOf(marker, first + marker.length) >= 0) {
    throw candidateError('merge_art_lab_candidate_invalid', 'runtime has an ambiguous payload bootstrap');
  }
  const encoded = payload.toString('base64');
  const bootstrap = `<script type="module">const b=atob('${encoded}');const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);const u=URL.createObjectURL(new Blob([a],{type:'text/javascript'}));import(u).finally(()=>URL.revokeObjectURL(u));</script>`;
  return Buffer.from(`${indexHtml.slice(0, first)}${bootstrap}${indexHtml.slice(first + marker.length)}`, 'utf8');
}

function validateQa(report, manifest) {
  if (report?.schema !== 'merge.art-qa-report.v1'
    || report.artPackHash !== manifest.artPackHash
    || report.runtimeArtifactDigest !== manifest.runtimeArtifactDigest
    || report.gameplayTerminalTraceEqual !== true
    || report.runs?.baseline?.completedCycle !== true
    || report.runs?.candidatePortrait?.completedCycle !== true
    || report.runs?.candidateLandscape?.completedCycle !== true) {
    throw candidateError('merge_art_lab_candidate_invalid', 'QA report does not prove the exact runtime');
  }
  for (const run of [report.runs.candidatePortrait, report.runs.candidateLandscape]) {
    const performance = run.performance || {};
    if (performance.medianFrameMs > 22 || performance.p95FrameMs > 50 || performance.longFrameRatio > 0.03) {
      throw candidateError('merge_art_lab_candidate_invalid', 'QA report does not pass the performance budget');
    }
  }
  return {
    schema: report.schema,
    reportDigest: sha256Hex(Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')),
    gameplayTraceEqual: true,
    portrait: report.runs.candidatePortrait.performance,
    landscape: report.runs.candidateLandscape.performance,
  };
}

export function buildMergeArtLabCandidate({ artifactRoot, qaRoot } = {}) {
  const root = path.resolve(String(artifactRoot || ''));
  const qa = path.resolve(String(qaRoot || path.join(root, 'qa')));
  const artifactBytes = readFileExact(path.join(root, 'merge-artifact.json'), 'merge art manifest', {
    trustedRoot: root,
    maxBytes: 2 * 1024 * 1024,
  });
  const artifact = parseJson(artifactBytes, 'merge art manifest');
  if (artifact?.schema !== 'merge.art-runtime-artifact.v1'
    || !HASH.test(String(artifact.artPackHash || ''))
    || !HASH.test(String(artifact.compilerDigest || ''))
    || !HASH.test(String(artifact.providerPolicyDigest || ''))
    || !DIGEST.test(String(artifact.runtimeArtifactDigest || ''))
    || !WORLD_ID.test(String(artifact.world?.worldId || ''))
    || typeof artifact.world?.title !== 'string' || !artifact.world.title.trim()
    || !/^[a-f0-9]{40}$/.test(String(artifact.source?.commit || ''))
    || !/^[a-f0-9]{40}$/.test(String(artifact.source?.tree || ''))
    || artifact.budgetReceipt?.provider !== 'openai.builtin-imagegen.v1'
    || !Number.isInteger(artifact.budgetReceipt?.calls) || artifact.budgetReceipt.calls < 1
    || artifact.budgetReceipt?.marginalCostMicros !== 0
    || artifact.budgetReceipt?.priceKnown !== true) {
    throw candidateError('merge_art_lab_candidate_invalid', 'merge art manifest identity is invalid');
  }
  const runtimeRoot = path.join(root, 'runtime');
  const index = readFileExact(path.join(runtimeRoot, 'index.html'), 'merge art index', {
    trustedRoot: runtimeRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  const payload = readFileExact(path.join(runtimeRoot, 'payload.js'), 'merge art payload', {
    trustedRoot: runtimeRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  assertFileEntry(index, fileEntry(artifact, 'index.html'), 'runtime index');
  assertFileEntry(payload, fileEntry(artifact, 'payload.js'), 'runtime payload');
  const qaBytes = readFileExact(path.join(qa, 'qa-report.json'), 'merge art QA report', {
    trustedRoot: qa,
    maxBytes: 2 * 1024 * 1024,
  });
  const qaReport = parseJson(qaBytes, 'merge art QA report');
  const qaEvidence = validateQa(qaReport, artifact);
  if (sha256Hex(qaBytes) !== qaEvidence.reportDigest) {
    throw candidateError('merge_art_lab_candidate_invalid', 'QA report bytes are non-canonical');
  }
  const cover = readFileExact(path.join(qa, `${artifact.world.worldId}-portrait.png`), 'merge art cover', {
    trustedRoot: qa,
    maxBytes: 8 * 1024 * 1024,
  });
  const patch = readFileExact(path.join(root, 'trusted-adapter.patch'), 'trusted art adapter patch', {
    trustedRoot: root,
    maxBytes: 4 * 1024 * 1024,
  });
  if (sha256Hex(patch) !== `sha256:${artifact.adapterPatchSha256}`) {
    throw candidateError('merge_art_lab_candidate_invalid', 'trusted adapter patch differs from the artifact manifest');
  }
  const id = `merge-art-${artifact.world.worldId}-${artifact.artPackHash.slice(0, 12)}-${artifact.compilerDigest.slice(0, 12)}`;
  const html = inlinePayload(index.toString('utf8'), payload);
  const manifest = {
    schema: 'merge.art-lab-candidate.v1',
    id,
    baselineId: artifact.source.playablePath,
    baseCommit: artifact.source.commit,
    baselineTree: artifact.source.tree,
    artPackHash: artifact.artPackHash,
    compilerDigest: artifact.compilerDigest,
    providerPolicyDigest: artifact.providerPolicyDigest,
    budgetReceipt: artifact.budgetReceipt,
    runtimeArtifactDigest: artifact.runtimeArtifactDigest,
    templateContractDigest: artifact.templateContractDigest,
    world: artifact.world,
    autoplayPassed: true,
    artifactClass: 'merge-raster-art-v1',
    qa: qaEvidence,
    htmlSha256: sha256Hex(html),
    coverSha256: sha256Hex(cover),
    patchSha256: sha256Hex(patch),
  };
  return { id, manifest, html, cover, patch };
}

export function publishMergeArtLabCandidate({ artifactRoot, qaRoot, ugcRoot } = {}) {
  const candidate = buildMergeArtLabCandidate({ artifactRoot, qaRoot });
  const root = path.resolve(String(ugcRoot || ''));
  const localRoot = path.join(root, '.local-experiments');
  const publicRoot = path.join(root, 'u', 'local-experiments');
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(publicRoot, { recursive: true });
  const staging = mkdtempSync(path.join(localRoot, `.staging-${candidate.id}-`));
  try {
    const staged = {
      html: path.join(staging, 'candidate.html'),
      cover: path.join(staging, 'candidate.cover.png'),
      patch: path.join(staging, 'candidate.patch'),
      manifest: path.join(staging, 'candidate.json'),
    };
    writeFileSync(staged.html, candidate.html);
    writeFileSync(staged.cover, candidate.cover);
    writeFileSync(staged.patch, candidate.patch);
    writeFileSync(staged.manifest, `${JSON.stringify(candidate.manifest, null, 2)}\n`);
    const localRoots = { stagedRoot: staging, finalRoot: localRoot };
    const publicRoots = { stagedRoot: staging, finalRoot: publicRoot };
    commitFile(staged.html, path.join(publicRoot, `${candidate.id}.html`), 'merge art candidate html', publicRoots);
    commitFile(staged.cover, path.join(publicRoot, `${candidate.id}.cover.png`), 'merge art candidate cover', publicRoots);
    commitFile(staged.patch, path.join(localRoot, `${candidate.id}.patch`), 'merge art candidate patch', localRoots);
    const marker = commitFile(staged.manifest, path.join(localRoot, `${candidate.id}.json`), 'merge art candidate manifest', localRoots);
    return { id: candidate.id, manifest: candidate.manifest, replayed: marker === 'replayed' };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
