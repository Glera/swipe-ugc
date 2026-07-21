import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artTemplateContract,
  artTemplateContractDigest,
  assertArtSourcePack,
  canonicalize,
  sha256Bytes,
} from './contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const compilerFile = fileURLToPath(import.meta.url);
const compilerContractFile = join(here, 'merge.art-compiler-contract.v1.json');
const normalizerFile = join(here, 'normalize_merge_art.py');
const staticPlayerTemplateFile = join(here, 'runtime', 'static-art-player.ts');
const SOURCE_IMPORT_START = '// Sakura cherry-blossom background';
const SOURCE_IMPORT_END = "import { HALF_LOCKED_TILE_B64, pickStage2LockArt } from './lock-assets';";
const SPINE_IMPORT = "import { initSpine, drawAllSpine, isSpineReady, setAnimation as setCharAnimation, initFinger, isFingerReady, setFingerAnimation, freezeFingerAnimation, drawFinger } from './spine-player';";
const STATIC_IMPORT = "import { initSpine, drawAllSpine, isSpineReady, setAnimation as setCharAnimation, initFinger, isFingerReady, setFingerAnimation, freezeFingerAnimation, drawFinger } from './static-art-player';";

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || `${commandName} failed`).slice(-16000);
    throw new Error(`${options.code || 'merge_art_command_failed'}: ${details}`);
  }
  const output = String(result.stdout || '');
  return options.raw ? output : output.trim();
}

function sha256Framed(files) {
  const hash = createHash('sha256').update('merge.raster-art-compiler.v1\0');
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const bytes = readFileSync(file.path);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(name).update(Buffer.from([0])).update(length).update(bytes);
  }
  return hash.digest('hex');
}

export function resolveMergeArtCompilerDigest() {
  return sha256Framed([
    { name: 'compiler.mjs', path: compilerFile },
    { name: 'merge.art-compiler-contract.v1.json', path: compilerContractFile },
    { name: 'normalize_merge_art.py', path: normalizerFile },
    { name: 'runtime/static-art-player.ts', path: staticPlayerTemplateFile },
  ]);
}

function exactOnce(value, needle, replacement, label) {
  const first = value.indexOf(needle);
  if (first < 0 || value.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`merge_art_adapter_anchor_mismatch: ${label}`);
  }
  return `${value.slice(0, first)}${replacement}${value.slice(first + needle.length)}`;
}

function generatedImportBlock() {
  return [
    "// Generated only inside the content-addressed raster-art candidate.",
    "import {",
    "  BG_IMAGE_B64, GENERATOR_B64, COINBOX_B64, TILE_LOCKED_V2_B64,",
    "  FLOWER_01_B64, FLOWER_02_B64, FLOWER_04_B64, FLOWER_05_B64, FLOWER_09_B64, FLOWER_10_B64, FLOWER_13_B64,",
    "  BUTTERFLY_01_B64, BUTTERFLY_04_B64, BUTTERFLY_05_B64, BUTTERFLY_08_B64,",
    "  BIRD_01_B64, BIRD_03_B64, BIRD_06_REPLACEMENT_B64,",
    "  ORANGERY_03_B64, ORANGERY_04_B64, ORANGERY_05_B64,",
    "} from './generated-art-pack';",
    "// Neutral board tiles are part of the pinned gameplay chrome, not a generated slot.",
    "import TILE_COMMON_LIGHT_B64 from '../assets/source/tile_common_light_v1.webp?inline';",
    "import TILE_COMMON_DARK_B64 from '../assets/source/tile_common_dark_v1.webp?inline';",
  ].join('\n');
}

export function adaptMergeMainSource(source) {
  const start = source.indexOf(SOURCE_IMPORT_START);
  const end = source.indexOf(SOURCE_IMPORT_END);
  if (start < 0 || end < 0 || end <= start || source.indexOf(SOURCE_IMPORT_START, start + 1) >= 0
    || source.indexOf(SOURCE_IMPORT_END, end + 1) >= 0) {
    throw new Error('merge_art_adapter_anchor_mismatch: generated art import region');
  }
  const forbiddenSentinels = artTemplateContract.runtime.gameplaySourcePolicy === 'exact-base-plus-trusted-art-adapter'
    ? JSON.parse(readFileSync(compilerContractFile, 'utf8')).adapter.forbiddenGameplayTokens : [];
  const beforeCounts = new Map(forbiddenSentinels.map((token) => [token, source.split(token).length - 1]));
  const randomBefore = source.split('Math.random').length - 1;
  let result = `${source.slice(0, start)}${generatedImportBlock()}\n${source.slice(end)}`;
  result = exactOnce(result, SPINE_IMPORT, STATIC_IMPORT, 'spine import');
  for (const [token, count] of beforeCounts) {
    if (count < 1 || result.split(token).length - 1 !== count) {
      throw new Error(`merge_art_gameplay_source_changed: ${token}`);
    }
  }
  if (result.split('Math.random').length - 1 !== randomBefore) {
    throw new Error('merge_art_gameplay_random_changed');
  }
  return result;
}

function importLine(name, filename) {
  return `import ${name} from '../assets/generated/__ART_PACK_HASH__/${filename}?inline';`;
}

export function generatedArtPackModule(artPackHash) {
  if (!/^[0-9a-f]{64}$/.test(String(artPackHash || ''))) throw new TypeError('invalid artPackHash');
  const imports = [
    importLine('BG_PORTRAIT', 'background-portrait.webp'),
    importLine('BG_LANDSCAPE', 'background-landscape.webp'),
    importLine('GENERATOR', 'generator.webp'),
    importLine('LOCK_STAGE_1', 'lock-stage-1.webp'),
    importLine('LOCK_STAGE_2', 'lock-stage-2.webp'),
  ];
  const exportNames = [
    'FLOWER_01_B64', 'FLOWER_02_B64', 'FLOWER_04_B64', 'FLOWER_05_B64', 'FLOWER_09_B64', 'FLOWER_10_B64', 'FLOWER_13_B64',
    'BUTTERFLY_01_B64', 'BUTTERFLY_04_B64', 'BUTTERFLY_05_B64', 'BUTTERFLY_08_B64',
    'BIRD_01_B64', 'BIRD_03_B64', 'BIRD_06_REPLACEMENT_B64',
    'ORANGERY_03_B64', 'ORANGERY_04_B64', 'ORANGERY_05_B64',
  ];
  const levels = [7, 4, 3, 3];
  let offset = 0;
  levels.forEach((count, chainIndex) => {
    for (let level = 1; level <= count; level += 1) {
      imports.push(importLine(`CHAIN_${chainIndex + 1}_${level}`, `chain-${chainIndex + 1}-level-${String(level).padStart(2, '0')}.webp`));
    }
  });
  const exports = [
    "export const BG_IMAGE_B64 = window.matchMedia?.('(orientation: landscape)').matches ? BG_LANDSCAPE : BG_PORTRAIT;",
    'export const GENERATOR_B64 = GENERATOR;',
    'export const COINBOX_B64 = LOCK_STAGE_1;',
    'export const TILE_LOCKED_V2_B64 = LOCK_STAGE_2;',
  ];
  levels.forEach((count, chainIndex) => {
    for (let level = 1; level <= count; level += 1) {
      exports.push(`export const ${exportNames[offset]} = CHAIN_${chainIndex + 1}_${level};`);
      offset += 1;
    }
  });
  return `${imports.join('\n').replaceAll('__ART_PACK_HASH__', artPackHash)}\n\n${exports.join('\n')}\n`;
}

function regularFiles(root, current = root) {
  const values = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) values.push(...regularFiles(root, absolute));
    else if (entry.isFile()) values.push(relative(root, absolute).split(sep).join('/'));
  }
  return values.sort();
}

function copyNoReplace(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  try {
    linkSync(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    copyFileSync(source, destination, 0x0001);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function assertCleanPinnedCheckout(playablesRoot) {
  const commit = command('git', ['rev-parse', 'HEAD'], { cwd: playablesRoot });
  const tree = command('git', ['rev-parse', 'HEAD^{tree}'], { cwd: playablesRoot });
  const playableTree = command('git', ['rev-parse', `HEAD:${artTemplateContract.source.playablePath}`], { cwd: playablesRoot });
  if (commit !== artTemplateContract.source.commit || tree !== artTemplateContract.source.tree
    || playableTree !== artTemplateContract.source.playableTree) {
    throw new Error('merge_art_source_identity_mismatch');
  }
  if (command('git', ['status', '--porcelain'], { cwd: playablesRoot })) throw new Error('merge_art_source_dirty');
}

function normalize({ packRoot, sourcePackFile, output }) {
  const result = command('python3', [
    normalizerFile,
    '--pack-root', packRoot,
    '--manifest', sourcePackFile,
    '--template', join(here, 'merge.art-template.v1.json'),
    '--out', output,
  ], { code: 'merge_art_normalization_failed' });
  return JSON.parse(result);
}

function applyAdapter(checkout, normalizedRoot, artPackHash) {
  const playable = join(checkout, artTemplateContract.source.playablePath);
  const assetRoot = join(playable, 'assets', 'generated', artPackHash);
  mkdirSync(assetRoot, { recursive: true });
  for (const file of regularFiles(normalizedRoot)) copyFileSync(join(normalizedRoot, file), join(assetRoot, file));
  for (const character of artTemplateContract.providedCharacters) {
    copyFileSync(join(here, character.path), join(assetRoot, `character-${character.slot}.png`));
  }
  const sourceFile = join(playable, 'src', 'main.ts');
  writeFileSync(sourceFile, adaptMergeMainSource(readFileSync(sourceFile, 'utf8')));
  writeFileSync(join(playable, 'src', 'generated-art-pack.ts'), generatedArtPackModule(artPackHash));
  writeFileSync(
    join(playable, 'src', 'static-art-player.ts'),
    readFileSync(staticPlayerTemplateFile, 'utf8').replaceAll('__ART_PACK_HASH__', artPackHash),
  );
  const status = command('git', ['status', '--short', '--untracked-files=all'], { cwd: checkout, raw: true }).split('\n').filter(Boolean);
  const allowed = status.every((line) => {
    const file = line.slice(3);
    return file === `${artTemplateContract.source.playablePath}/src/main.ts`
      || file === `${artTemplateContract.source.playablePath}/src/generated-art-pack.ts`
      || file === `${artTemplateContract.source.playablePath}/src/static-art-player.ts`
      || file.startsWith(`${artTemplateContract.source.playablePath}/assets/generated/${artPackHash}/`)
      || file === 'node_modules';
  });
  if (!allowed || status.length < 4) throw new Error(`merge_art_adapter_scope_mismatch: ${status.join(', ')}`);
}

function buildRuntime(checkout) {
  const nodeModules = join(checkout, 'node_modules');
  const hostNodeModules = join(resolve(checkout, '..', '..'), 'node_modules');
  if (!existsSync(nodeModules) && existsSync(hostNodeModules)) symlinkSync(hostNodeModules, nodeModules, 'dir');
  command('npx', ['vite', 'build'], {
    cwd: checkout,
    env: {
      PLAYABLE: artTemplateContract.source.playablePath,
      SWIPE: '1',
      BUILD_STAMP: artTemplateContract.source.buildStamp,
      RUNTIME_ARTIFACT_DIGEST: `sha256:${'0'.repeat(64)}`,
    },
    code: 'merge_art_vite_build_failed',
  });
  const dist = join(checkout, artTemplateContract.source.playablePath, 'dist-swipe');
  command('node', [join(checkout, 'scripts', 'externalize-videos.mjs'), join(dist, 'index.html')], { cwd: checkout });
  command('node', [join(checkout, 'scripts', 'blob-boot-transform.mjs'), join(dist, 'index.html')], { cwd: checkout });
  command('node', [
    join(checkout, 'scripts', 'stamp-runtime-artifact.mjs'),
    dist,
    artTemplateContract.source.playablePath,
    artTemplateContract.source.commit,
  ], { cwd: checkout });
  const manifest = JSON.parse(readFileSync(join(dist, 'runtime-artifact.json'), 'utf8'));
  const html = readFileSync(join(dist, 'index.html'));
  for (const forbidden of artTemplateContract.runtime.forbiddenModules) {
    if (html.includes(forbidden)) throw new Error(`merge_art_forbidden_runtime_bytes: ${forbidden}`);
  }
  return { dist, manifest };
}

export function compileMergeArtSourcePack({ packRoot, playablesRepo, outputRoot } = {}) {
  const resolvedPackRoot = resolve(String(packRoot || ''));
  const resolvedRepo = resolve(String(playablesRepo || ''));
  const resolvedOutput = resolve(String(outputRoot || ''));
  const sourcePackFile = join(resolvedPackRoot, 'source-pack.json');
  const sourcePack = JSON.parse(readFileSync(sourcePackFile, 'utf8'));
  assertArtSourcePack(sourcePack, { packRoot: resolvedPackRoot, verifyFiles: true });
  const compilerDigest = resolveMergeArtCompilerDigest();
  const artifactRoot = join(resolvedOutput, sourcePack.artPackHash);
  const committedManifest = join(artifactRoot, 'merge-artifact.json');
  if (existsSync(committedManifest)) {
    const current = JSON.parse(readFileSync(committedManifest, 'utf8'));
    if (current.artPackHash !== sourcePack.artPackHash || current.compilerDigest !== compilerDigest) {
      throw new Error('merge_art_artifact_conflict');
    }
    return current;
  }
  mkdirSync(resolvedOutput, { recursive: true });
  const staging = join(resolvedOutput, `.staging-${sourcePack.artPackHash}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: false });
  const normalizedRoot = join(staging, 'normalized');
  const checkout = join(staging, 'playables');
  let worktreeAdded = false;
  try {
    const normalized = normalize({ packRoot: resolvedPackRoot, sourcePackFile, output: normalizedRoot });
    command('git', ['worktree', 'add', '--detach', checkout, artTemplateContract.source.commit], { cwd: resolvedRepo });
    worktreeAdded = true;
    assertCleanPinnedCheckout(checkout);
    const hostNodeModules = join(resolvedRepo, 'node_modules');
    if (!existsSync(hostNodeModules)) throw new Error('merge_art_playables_dependencies_missing');
    symlinkSync(hostNodeModules, join(checkout, 'node_modules'), 'dir');
    applyAdapter(checkout, normalizedRoot, sourcePack.artPackHash);
    const runtime = buildRuntime(checkout);
    const stagedArtifact = join(staging, 'artifact');
    mkdirSync(stagedArtifact);
    cpSync(runtime.dist, join(stagedArtifact, 'runtime'), { recursive: true });
    const adapterPatch = command('git', ['diff', '--binary', '--', artTemplateContract.source.playablePath], { cwd: checkout });
    writeFileSync(join(stagedArtifact, 'trusted-adapter.patch'), adapterPatch);
    const artifact = {
      schema: 'merge.art-runtime-artifact.v1',
      artPackHash: sourcePack.artPackHash,
      templateContractDigest: artTemplateContractDigest,
      providerPolicyDigest: sourcePack.providerPolicyDigest,
      budgetReceipt: sourcePack.budgetReceipt,
      compilerDigest,
      source: artTemplateContract.source,
      world: sourcePack.world,
      normalized,
      adapterPatchSha256: sha256Bytes(Buffer.from(adapterPatch)),
      runtimeArtifactDigest: runtime.manifest.digest,
      runtimeFiles: runtime.manifest.files,
    };
    writeJson(join(stagedArtifact, 'merge-artifact.json'), artifact);
    mkdirSync(artifactRoot, { recursive: false });
    const artifactFiles = regularFiles(stagedArtifact);
    for (const file of artifactFiles.filter((entry) => entry !== 'merge-artifact.json')) {
      copyNoReplace(join(stagedArtifact, file), join(artifactRoot, file));
    }
    // The manifest is the commit marker. Readers must never observe it before
    // every byte it authenticates has been linked into the immutable artifact.
    copyNoReplace(join(stagedArtifact, 'merge-artifact.json'), join(artifactRoot, 'merge-artifact.json'));
    return artifact;
  } finally {
    if (worktreeAdded) {
      try { command('git', ['worktree', 'remove', '--force', checkout], { cwd: resolvedRepo }); } catch { /* best effort cleanup */ }
    }
    rmSync(staging, { recursive: true, force: true });
  }
}

export { canonicalize };
