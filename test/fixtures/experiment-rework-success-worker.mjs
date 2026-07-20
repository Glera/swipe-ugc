#!/usr/bin/env node
import path from 'node:path';

import {
  loadWorkerInputEnvelope,
  publishExperimentResult,
} from '../../worker/publish-local.mjs';

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  args[process.argv[index].replace(/^--/, '')] = process.argv[index + 1];
}
if (Object.keys(args).some((key) => !['input-digest', 'input-envelope'].includes(key))) {
  throw new Error('fixture received parallel CLI authority');
}

const input = loadWorkerInputEnvelope({
  inputPath: String(args['input-envelope'] || ''),
  expectedInputDigest: String(args['input-digest'] || ''),
});
const root = process.cwd();
const published = publishExperimentResult({
  localRoot: path.join(root, '.local-experiments'),
  artifactRoot: path.join(root, 'u', 'local-experiments'),
  input,
  patch: [
    'diff --git a/marble-sort-swipe/src/main.ts b/marble-sort-swipe/src/main.ts',
    'index 1111111..2222222 100644',
    '--- a/marble-sort-swipe/src/main.ts',
    '+++ b/marble-sort-swipe/src/main.ts',
    '@@ -1 +1 @@',
    '-const payoff = "hidden";',
    '+const payoff = "legible";',
    '',
  ].join('\n'),
  html: '<!doctype html><meta charset="utf-8"><title>fenced acceptance</title>',
  coverPng: Buffer.from('89504e470d0a1a0a', 'hex'),
  fields: {
    title: 'Fenced acceptance candidate',
    concept: {
      prompt: 'Implement the exact reviewed tuning goal.',
      pitch: 'The delayed payoff is now legible.',
      mechanic: 'Preserve the parent rule and clarify its timing.',
      feeling: 'A readable release after tension.',
    },
    autoplayPassed: true,
    autoplayOutcome: { budgetSeconds: 150, proven: true, reason: 'win_proven', runs: 1 },
    wallTimeMs: 1000,
    agentInvocations: 1,
    playtestRuns: 1,
    conformance: { idleMs: 30_000, rafFrames: 1800 },
    autoplay: { durationMs: 12_000, rafFrames: 720, runNumber: 1, visualStates: 4 },
    files: ['marble-sort-swipe/src/main.ts'],
    agentSummary: 'Deterministic cross-repo acceptance fixture.',
    createdAt: '2026-07-19T00:00:00.000Z',
    coverBytes: 8,
  },
});

process.stdout.write(`RESULT ${JSON.stringify(published.result)}\n`);
