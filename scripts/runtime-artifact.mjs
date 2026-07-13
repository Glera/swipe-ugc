#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { verifyRuntimeArtifact } from '../worker/runtime-artifact.mjs';

export {
  RUNTIME_ARTIFACT_MANIFEST,
  RUNTIME_DIGEST_PLACEHOLDER,
  isSha256Digest,
  sha256File,
  verifyRuntimeArtifact,
} from '../worker/runtime-artifact.mjs';

const invoked = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  const [command, root] = process.argv.slice(2);
  if (command !== '--verify' || !root) {
    console.error('Usage: node scripts/runtime-artifact.mjs --verify <artifact-root>');
    process.exit(1);
  }
  try {
    process.stdout.write(`${verifyRuntimeArtifact(root).digest}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
