#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMergeCatalogRuntime } from '../recipes/merge/art-v1/catalog-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { outputRoot: path.join(root, '.local-catalog-runtimes') };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  if (name === '--candidate') options.candidateFile = path.resolve(value);
  else if (name === '--html') options.htmlFile = path.resolve(value);
  else if (name === '--source-qa') options.sourceQaFile = path.resolve(value);
  else if (name === '--out') options.outputRoot = path.resolve(value);
  else if (name === '--playables') options.playablesRepo = path.resolve(value);
  else if (name === '--source-commit') options.sourceCommit = value;
  else throw new Error(`unknown option ${name}`);
}
if (!options.candidateFile || !options.htmlFile || !options.sourceQaFile || !options.playablesRepo) {
  throw new Error('--candidate, --html, --source-qa and --playables are required');
}
if (!options.sourceCommit) {
  options.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('merge_catalog_source_dirty: commit the adapter before building release bytes');
}
console.log(JSON.stringify(buildMergeCatalogRuntime(options), null, 2));
