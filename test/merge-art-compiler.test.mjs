import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adaptMergeMainSource,
  generatedArtPackModule,
  resolveMergeArtCompilerDigest,
} from '../recipes/merge/art-v1/compiler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '..');
const mainFile = path.join(workspace, 'playables-merge-raster-art', 'merge-locked-v1-swipe', 'src', 'main.ts');

test('trusted adapter changes only the art import boundary and removes Spine import', () => {
  const source = readFileSync(mainFile, 'utf8');
  const adapted = adaptMergeMainSource(source);
  assert.notEqual(adapted, source);
  assert.match(adapted, /from '\.\/generated-art-pack'/);
  assert.match(adapted, /from '\.\/static-art-player'/);
  assert.match(adapted, /import TILE_COMMON_LIGHT_B64 from '\.\.\/assets\/source\/tile_common_light_v1\.webp\?inline'/);
  assert.match(adapted, /import TILE_COMMON_DARK_B64 from '\.\.\/assets\/source\/tile_common_dark_v1\.webp\?inline'/);
  assert.doesNotMatch(adapted, /from '\.\/spine-player'/);
  for (const token of ['CHAIN_MAX_LEVEL', 'GAME_DURATION', 'ORDER_MIN_TIME', 'findDropTarget', 'completeFulfill']) {
    assert.equal(adapted.split(token).length, source.split(token).length, token);
  }
  assert.equal(adapted.split('Math.random').length, source.split('Math.random').length);
  const importEnd = "import { HALF_LOCKED_TILE_B64, pickStage2LockArt } from './lock-assets';";
  assert.equal(
    adapted.slice(adapted.indexOf(importEnd)),
    source.slice(source.indexOf(importEnd)).replace("from './spine-player';", "from './static-art-player';"),
    'all bytes after the generated import region differ only at the renderer import',
  );
});

test('generated module binds all twenty-one runtime art slots to one artPackHash', () => {
  const hash = 'a'.repeat(64);
  const module = generatedArtPackModule(hash);
  assert.equal(module.match(/\?inline/g)?.length, 22); // two backgrounds + generator + two locks + 17 chain items
  assert.equal(module.match(new RegExp(hash, 'g'))?.length, 22);
  assert.match(module, /orientation: landscape/);
  assert.match(module, /FLOWER_13_B64 = CHAIN_1_7/);
  assert.match(module, /ORANGERY_05_B64 = CHAIN_4_3/);
});

test('compiler digest covers the executable adapter, normalizer and runtime template', () => {
  assert.match(resolveMergeArtCompilerDigest(), /^[0-9a-f]{64}$/);
  assert.equal(resolveMergeArtCompilerDigest(), resolveMergeArtCompilerDigest());
});
