#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  artProviderPolicyDigest,
  artTemplateContractDigest,
  computeArtPackHash,
  readPngDimensions,
  sha256Bytes,
} from '../recipes/merge/art-v1/contract.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  if (name === '--world') options.world = path.resolve(value);
  else if (name === '--pack-root') options.packRoot = path.resolve(value);
  else throw new Error(`unknown option ${name}`);
}
if (!options.world || !options.packRoot) throw new Error('--world and --pack-root are required');
const brief = JSON.parse(readFileSync(options.world, 'utf8'));
if (brief.schema !== 'merge.art-world-brief.v1') throw new Error('invalid world brief schema');
const slots = Object.keys(brief.prompts);
const sources = Object.fromEntries(slots.map((slot) => {
  const file = path.join(options.packRoot, 'generated', `${slot}.png`);
  const bytes = readFileSync(file);
  const dimensions = readPngDimensions(bytes);
  return [slot, {
    path: `generated/${slot}.png`,
    sha256: sha256Bytes(bytes),
    bytes: statSync(file).size,
    ...dimensions,
    promptDigest: sha256Bytes(Buffer.from(`${brief.promptProfile}\n${brief.prompts[slot]}`, 'utf8')),
  }];
}));
const pack = {
  schema: 'merge.art-source-pack.v1',
  artPackHash: '',
  templateContractDigest: artTemplateContractDigest,
  providerPolicyDigest: artProviderPolicyDigest,
  world: {
    worldId: brief.worldId,
    title: brief.title,
    visualThesis: brief.visualThesis,
    palette: brief.palette,
    promptProfile: brief.promptProfile,
  },
  budgetReceipt: { provider: 'openai.builtin-imagegen.v1', calls: slots.length, marginalCostMicros: 0, priceKnown: true },
  sources,
};
pack.artPackHash = computeArtPackHash(pack);
writeFileSync(path.join(options.packRoot, 'source-pack.json'), `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ artPackHash: pack.artPackHash, slots }, null, 2));
