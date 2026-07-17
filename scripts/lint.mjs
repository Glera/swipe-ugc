import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'recipes/sort/recipe.mjs',
  'worker/hardening.mjs',
  'worker/bake.mjs',
  'worker/capture-cover.mjs',
  'worker/experiment.mjs',
  'worker/experiment-rework.mjs',
  'worker/model-invocation.mjs',
  'worker/result-contract.mjs',
  'worker/publish-local.mjs',
  'worker/publish-experiment.mjs',
  'worker/test-preview.mjs',
  'worker/worktree-integrity.mjs',
  'worker/sealed-gate-clone.mjs',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${file} failed syntax validation\n`);
    process.exit(result.status || 1);
  }
}

console.log(`[lint] ${files.length} generator and worker modules passed syntax validation`);
