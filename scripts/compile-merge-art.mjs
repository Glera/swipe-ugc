#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileMergeArtSourcePack } from '../recipes/merge/art-v1/compiler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  playablesRepo: path.resolve(root, '..', 'playables'),
  outputRoot: path.join(root, '.local-merge-artifacts'),
};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  if (name === '--pack-root') options.packRoot = path.resolve(value);
  else if (name === '--playables-repo') options.playablesRepo = path.resolve(value);
  else if (name === '--output-root') options.outputRoot = path.resolve(value);
  else throw new Error(`unknown option ${name}`);
}
if (!options.packRoot) throw new Error('--pack-root is required');
const result = compileMergeArtSourcePack(options);
console.log(JSON.stringify(result, null, 2));
