#!/usr/bin/env node
import path from 'node:path';

import { publishMergeArtLabCandidate } from '../recipes/merge/art-v1/lab-candidate.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  if (name === '--artifact-root') options.artifactRoot = path.resolve(value);
  else if (name === '--qa-root') options.qaRoot = path.resolve(value);
  else if (name === '--ugc-root') options.ugcRoot = path.resolve(value);
  else throw new Error(`unknown option ${name}`);
}
if (!options.artifactRoot || !options.ugcRoot) throw new Error('--artifact-root and --ugc-root are required');
console.log(JSON.stringify(publishMergeArtLabCandidate(options), null, 2));
