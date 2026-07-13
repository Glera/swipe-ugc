import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { canonicalize, sha256Jcs } from '../recipes/sort/levels/jcs.mjs';
import { promoteRuntimeRelease } from '../scripts/promote-runtime-release.mjs';
import {
  canonicalRuntimeOrigin,
  probeRuntimeReleaseHost,
} from '../scripts/probe-runtime-release-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'probe-runtime-release-host.mjs');
const baselineRoot = path.join(root, 'bases', 'sort-v2-levels-qa');
const catalogFile = path.join(root, 'generator', 'baselines.json');
const fixedReleaseId = '12345678-1234-4abc-8def-1234567890ab';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'trusted-host-probe-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const platformRoot = path.join(directory, 'platform');
  mkdirSync(platformRoot);
  const promoted = promoteRuntimeRelease({
    baselineRoot,
    catalogFile,
    platformRoot,
    mode: 'write',
  });
  const releaseRoot = path.join(platformRoot, ...promoted.target.split('/'));
  return { directory, platformRoot, promoted, releaseRoot };
}

function registrationFor(promoted, { origin = '', absolute = false } = {}) {
  const contentRoot = promoted.target;
  const prefix = absolute ? `${origin}/` : '';
  const descriptor = structuredClone(promoted.descriptor);
  const registration = {
    schema: 'runtime-release-registration.v1',
    releaseId: fixedReleaseId,
    descriptor,
    descriptorHash: sha256Jcs(descriptor),
    delivery: {
      indexLocator: `${prefix}${contentRoot}/${descriptor.indexPath}`,
      sidecarLocator: `${prefix}${contentRoot}/${descriptor.sidecarPath}`,
    },
    legacyVariantId: null,
  };
  registration.requestHash = sha256Jcs(registration);
  return registration;
}

async function hostPlatform(t, platformRoot, handler = null) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://host.invalid');
    requests.push(parsed.pathname);
    try {
      if (handler && await handler({ request, response, pathname: parsed.pathname })) return;
      const relative = parsed.pathname.replace(/^\/+/, '');
      const target = path.resolve(platformRoot, ...relative.split('/'));
      if (!target.startsWith(`${platformRoot}${path.sep}`)) {
        response.writeHead(400).end();
        return;
      }
      let bytes;
      try { bytes = readFileSync(target); }
      catch {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-length': bytes.length,
        'content-type': target.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

function childResult(child, stdin) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('trusted probe verifies exact hosted descriptor, sidecar, and every executable byte', async (t) => {
  const { platformRoot, promoted, releaseRoot } = fixture(t);
  const hosted = await hostPlatform(t, platformRoot);
  const registration = registrationFor(promoted);
  const evidence = await probeRuntimeReleaseHost({
    registration,
    origin: hosted.origin,
    now: new Date('2026-07-13T12:34:56Z'),
  });

  assert.deepEqual(Object.keys(evidence).sort(), [
    'descriptorHash',
    'evidenceDigest',
    'indexDigest',
    'indexLocator',
    'origin',
    'probe',
    'releaseId',
    'runtimeArtifactDigest',
    'schema',
    'sidecarDigest',
    'sidecarLocator',
    'verifiedAt',
  ]);
  assert.equal(evidence.releaseId, fixedReleaseId);
  assert.equal(evidence.descriptorHash, registration.descriptorHash);
  assert.equal(evidence.origin, hosted.origin);
  assert.equal(evidence.indexLocator, registration.delivery.indexLocator);
  assert.equal(evidence.sidecarLocator, registration.delivery.sidecarLocator);
  assert.equal(evidence.runtimeArtifactDigest, promoted.descriptor.runtimeArtifactDigest);
  assert.equal(evidence.indexDigest, sha256(readFileSync(path.join(releaseRoot, 'index.html'))));
  assert.equal(evidence.sidecarDigest, sha256(readFileSync(path.join(releaseRoot, 'runtime-artifact.json'))));
  assert.equal(evidence.verifiedAt, '2026-07-13T12:34:56.000Z');
  const withoutDigest = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'evidenceDigest'));
  assert.equal(evidence.evidenceDigest, sha256Jcs(withoutDigest));
  assert.deepEqual(hosted.requests, [
    `/${promoted.target}/runtime-release.json`,
    `/${promoted.target}/runtime-artifact.json`,
    `/${promoted.target}/index.html`,
    `/${promoted.target}/payload.js`,
  ]);

  const schema = JSON.parse(readFileSync(path.join(root, 'schemas', 'runtime-release-host-verification.v1.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...evidence, origin: 'https://user@runtime.example.test' }), false);
});

test('server-owned origin must already be canonical', () => {
  assert.equal(canonicalRuntimeOrigin('https://runtime.example.test'), 'https://runtime.example.test');
  assert.equal(canonicalRuntimeOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
  for (const value of [
    'https://runtime.example.test:443',
    'https://Runtime.example.test',
    'https://runtime.example.test/',
    'https://user@runtime.example.test',
  ]) assert.throws(() => canonicalRuntimeOrigin(value), /canonical|credentials/);
});

test('CLI stdin contract emits one canonical evidence line and no diagnostics', async (t) => {
  const { platformRoot, promoted } = fixture(t);
  const hosted = await hostPlatform(t, platformRoot);
  const registration = registrationFor(promoted);
  const child = spawn(process.execPath, [script, '--stdin', '--origin', hosted.origin], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = await childResult(child, JSON.stringify(registration));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const evidence = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${canonicalize(evidence)}\n`);
  assert.equal(evidence.schema, 'runtime-release-host-verification.v1');
  assert.equal(evidence.releaseId, fixedReleaseId);
});

test('CLI failure is nonzero with empty stdout', async (t) => {
  const { platformRoot, promoted } = fixture(t);
  const hosted = await hostPlatform(t, platformRoot);
  const registration = registrationFor(promoted);
  registration.requestHash = '0'.repeat(64);
  const child = spawn(process.execPath, [script, '--stdin', '--origin', hosted.origin], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = await childResult(child, JSON.stringify(registration));
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^runtime release registration requestHash is invalid\n$/);
  assert.deepEqual(hosted.requests, []);
});

test('redirects and cross-origin or query-bearing registration locators fail before authority', async (t) => {
  await t.test('redirect is never followed', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    let redirectedRequests = 0;
    const redirected = await hostPlatform(child, platformRoot, ({ response }) => {
      redirectedRequests += 1;
      response.writeHead(418).end();
      return true;
    });
    const hosted = await hostPlatform(child, platformRoot, ({ response, pathname }) => {
      if (!pathname.endsWith('/runtime-release.json')) return false;
      response.writeHead(302, { location: `${redirected.origin}/stolen` }).end();
      return true;
    });
    await assert.rejects(
      probeRuntimeReleaseHost({ registration: registrationFor(promoted), origin: hosted.origin }),
      /unsafe redirect/,
    );
    assert.equal(redirectedRequests, 0);
  });

  await t.test('cross-origin absolute locator is rejected without network', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot);
    const registration = registrationFor(promoted);
    registration.delivery.sidecarLocator = `https://other.example.test/${promoted.target}/runtime-artifact.json`;
    registration.requestHash = sha256Jcs(Object.fromEntries(
      Object.entries(registration).filter(([key]) => key !== 'requestHash'),
    ));
    await assert.rejects(
      probeRuntimeReleaseHost({ registration, origin: hosted.origin }),
      /same-origin HTTPS content-addressed URL/,
    );
    assert.deepEqual(hosted.requests, []);
  });

  await t.test('query-bearing locator is rejected without network', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot);
    const registration = registrationFor(promoted);
    registration.delivery.indexLocator += '?mutable=1';
    registration.requestHash = sha256Jcs(Object.fromEntries(
      Object.entries(registration).filter(([key]) => key !== 'requestHash'),
    ));
    await assert.rejects(
      probeRuntimeReleaseHost({ registration, origin: hosted.origin }),
      /exact content-addressed relative path/,
    );
    assert.deepEqual(hosted.requests, []);
  });
});

test('hosted descriptor or executable tampering is rejected', async (t) => {
  await t.test('descriptor byte drift', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot, ({ response, pathname }) => {
      if (!pathname.endsWith('/runtime-release.json')) return false;
      const tampered = Buffer.from(`${canonicalize(promoted.descriptor)}\n`, 'utf8');
      response.writeHead(200, { 'content-length': tampered.length }).end(tampered);
      return true;
    });
    await assert.rejects(
      probeRuntimeReleaseHost({ registration: registrationFor(promoted), origin: hosted.origin }),
      /differs from the exact registered descriptor/,
    );
  });

  await t.test('payload byte drift', async (child) => {
    const { platformRoot, promoted, releaseRoot } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot, ({ response, pathname }) => {
      if (!pathname.endsWith('/payload.js')) return false;
      const original = readFileSync(path.join(releaseRoot, 'payload.js'));
      const tampered = Buffer.from(original);
      tampered[0] ^= 1;
      response.writeHead(200, { 'content-length': tampered.length }).end(tampered);
      return true;
    });
    await assert.rejects(
      probeRuntimeReleaseHost({ registration: registrationFor(promoted), origin: hosted.origin }),
      /runtime executable integrity mismatch: payload\.js/,
    );
  });
});

test('missing, extra, and oversized content fail closed', async (t) => {
  await t.test('missing declared executable', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot, ({ response, pathname }) => {
      if (!pathname.endsWith('/payload.js')) return false;
      response.writeHead(404).end();
      return true;
    });
    await assert.rejects(
      probeRuntimeReleaseHost({ registration: registrationFor(promoted), origin: hosted.origin }),
      /runtime executable payload\.js returned HTTP 404/,
    );
  });

  await t.test('extra registration field', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot);
    const registration = registrationFor(promoted);
    registration.untrusted = true;
    registration.requestHash = sha256Jcs(Object.fromEntries(
      Object.entries(registration).filter(([key]) => key !== 'requestHash'),
    ));
    await assert.rejects(
      probeRuntimeReleaseHost({ registration, origin: hosted.origin }),
      /missing or extra fields/,
    );
    assert.deepEqual(hosted.requests, []);
  });

  await t.test('sidecar-declared extra executable changes the normalized artifact identity', async (child) => {
    const { platformRoot, promoted, releaseRoot } = fixture(child);
    const extra = Buffer.from('extra executable', 'utf8');
    const sidecar = JSON.parse(readFileSync(path.join(releaseRoot, 'runtime-artifact.json'), 'utf8'));
    sidecar.files.push({ path: 'z-extra.js', bytes: extra.length, sha256: sha256(extra) });
    const sidecarBytes = Buffer.from(JSON.stringify(sidecar), 'utf8');
    const hosted = await hostPlatform(child, platformRoot, ({ response, pathname }) => {
      if (pathname.endsWith('/runtime-artifact.json')) {
        response.writeHead(200, { 'content-length': sidecarBytes.length }).end(sidecarBytes);
        return true;
      }
      if (pathname.endsWith('/z-extra.js')) {
        response.writeHead(200, { 'content-length': extra.length }).end(extra);
        return true;
      }
      return false;
    });
    await assert.rejects(
      probeRuntimeReleaseHost({ registration: registrationFor(promoted), origin: hosted.origin }),
      /runtime artifact normalized digest mismatch/,
    );
  });

  await t.test('descriptor response larger than configured cap', async (child) => {
    const { platformRoot, promoted } = fixture(child);
    const hosted = await hostPlatform(child, platformRoot);
    await assert.rejects(
      probeRuntimeReleaseHost({
        registration: registrationFor(promoted),
        origin: hosted.origin,
        limits: { maxDescriptorBytes: 32 },
      }),
      /descriptor exceeds the trusted host probe byte limit/,
    );
  });
});

test('a stalled host is bounded by the per-request timeout', async (t) => {
  const { platformRoot, promoted } = fixture(t);
  const hosted = await hostPlatform(t, platformRoot, ({ response, pathname }) => {
    if (!pathname.endsWith('/runtime-release.json')) return false;
    const timer = setTimeout(() => {
      if (!response.destroyed) response.writeHead(200).end('{}');
    }, 500);
    timer.unref();
    return true;
  });
  await assert.rejects(
    probeRuntimeReleaseHost({
      registration: registrationFor(promoted),
      origin: hosted.origin,
      limits: { timeoutMs: 40, overallTimeoutMs: 200 },
    }),
    /descriptor timed out/,
  );
});
