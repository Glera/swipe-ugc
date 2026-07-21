import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  buildMergeCatalogRuntime,
  mergeRasterLevelSpec,
  mergeRasterQaGateDigest,
  mergeRasterRuntimeContractDigest,
  mergeRasterVariant,
} from '../recipes/merge/art-v1/catalog-runtime.mjs';
import { promoteMergeCatalogRuntime } from '../scripts/promote-merge-catalog-runtime.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(root) {
  const candidateRoot = path.join(root, 'candidate');
  const publicRoot = path.join(candidateRoot, 'public');
  const playables = path.join(root, 'playables');
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(path.join(playables, 'scripts'), { recursive: true });
  const inner = Buffer.from(`<!doctype html><script>
    parent.postMessage({source:'playable',type:'static_ready'},'*');
    window.__playable={swipe:{startAutoPlay(){for(let i=0;i<3;i++)parent.postMessage({source:'playable',type:'progress'},'*');parent.postMessage({source:'playable',type:'command_seen',command:'startAutoPlay'},'*')}}};
  </script>`);
  const pack = 'a'.repeat(64);
  const candidate = {
    schema: 'merge.art-lab-candidate.v1',
    id: `merge-art-test-world-${pack.slice(0, 12)}-${'b'.repeat(12)}`,
    baselineId: 'merge-locked-v1-swipe',
    baseCommit: '1'.repeat(40),
    artPackHash: pack,
    compilerDigest: 'b'.repeat(64),
    providerPolicyDigest: 'c'.repeat(64),
    runtimeArtifactDigest: `sha256:${'d'.repeat(64)}`,
    templateContractDigest: 'e'.repeat(64),
    autoplayPassed: true,
    artifactClass: 'merge-raster-art-v1',
    qa: {},
    htmlSha256: `sha256:${sha256(inner)}`,
  };
  const candidateFile = path.join(candidateRoot, 'candidate.json');
  const htmlFile = path.join(publicRoot, 'candidate.html');
  const sourceQaFile = path.join(candidateRoot, 'qa-report.json');
  const sourceQa = { schema: 'merge.art-qa-report.v1', evidence: 'exact-fixture' };
  const sourceQaBytes = Buffer.from(`${JSON.stringify(sourceQa, null, 2)}\n`);
  candidate.qa.reportDigest = `sha256:${sha256(sourceQaBytes)}`;
  writeFileSync(candidateFile, JSON.stringify(candidate));
  writeFileSync(htmlFile, inner);
  writeFileSync(sourceQaFile, sourceQaBytes);
  writeFileSync(path.join(playables, 'scripts', 'stamp-runtime-artifact.mjs'), `
    import {createHash} from 'node:crypto';import {readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
    const root=process.argv[2], digest='sha256:'+('9'.repeat(64)), file=path.join(root,'index.html');
    const bytes=Buffer.from(readFileSync(file,'utf8').replaceAll('sha256:'+('0'.repeat(64)),digest));writeFileSync(file,bytes);
    writeFileSync(path.join(root,'runtime-artifact.json'),JSON.stringify({schema:'runtime-artifact.v1',playableId:process.argv[3],digest,sourceCommit:process.argv[4],files:[{path:'index.html',bytes:bytes.length,sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex')}]}));
  `);
  return { candidate, candidateFile, htmlFile, sourceQaFile, sourceQa, playables };
}

async function serve(root, spec) {
  const host = `<!doctype html><iframe id="game" src="/runtime/index.html?level_config=catalog_required&expected_spec_hash=${spec.specHash}"></iframe><script>
    window.messages=[];addEventListener('message',event=>{messages.push(event.data);if(event.data?.type==='configure_ready')document.getElementById('game').contentWindow.postMessage({type:'configure_level',nonce:event.data.nonce,spec:${JSON.stringify(spec)}},event.origin)});
  </script>`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(host); return; }
    const file = path.join(root, pathname.replace(/^\/runtime\//, ''));
    try { if (!statSync(file).isFile()) throw new Error('not file'); response.setHeader('content-type', 'text/html'); response.end(readFileSync(file)); }
    catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('builds one content-addressed runtime and proves exact configure/relay behavior', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-catalog-runtime-'));
  try {
    const value = fixture(root);
    const outputRoot = path.join(root, 'out');
    const options = { ...value, outputRoot, playablesRepo: value.playables, sourceCommit: '2'.repeat(40) };
    const first = buildMergeCatalogRuntime(options);
    const replay = buildMergeCatalogRuntime(options);
    assert.deepEqual(replay, first);
    assert.equal(first.variant, mergeRasterVariant(value.candidate.artPackHash));
    assert.equal(first.runtimeContractDigest, mergeRasterRuntimeContractDigest);
    assert.equal(first.qaGateDigest, mergeRasterQaGateDigest);
    assert.equal(first.levelSpec.specHash, mergeRasterLevelSpec(value.candidate, value.sourceQa).specHash);
    assert.match(first.runtimeArtifactDigest, /^sha256:[0-9a-f]{64}$/);
    const runtimeRoot = path.join(outputRoot, first.runtimeArtifactDigest.slice(7), 'runtime');
    const { server, origin } = await serve(runtimeRoot, first.levelSpec);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
      const external = [];
      page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('blob:')) external.push(request.url()); });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.messages.some(item => item?.type === 'configured'));
      const messages = await page.evaluate(() => window.messages);
      assert.equal(messages.filter(item => item?.type === 'configured').length, 1);
      assert.equal(messages.find(item => item?.type === 'configured').appliedSpecHash, first.levelSpec.specHash);
      assert.deepEqual(external, []);
      await page.locator('#game').evaluate(element => element.contentWindow.postMessage({ target: 'playable-swipe', type: 'startAutoPlay' }, '*'));
      await page.waitForFunction(() => window.messages.some(item => item?.type === 'command_seen'));
      const afterCommand = await page.evaluate(() => window.messages);
      assert.equal(afterCommand.filter(item => item?.type === 'progress').length, 3);
    } finally {
      await browser.close();
      await new Promise(resolvePromise => server.close(resolvePromise));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derives a distinct catalog variant for every art pack identity', () => {
  assert.equal(mergeRasterVariant('a'.repeat(64)), `raster-art-${'a'.repeat(12)}`);
  assert.notEqual(mergeRasterVariant('a'.repeat(64)), mergeRasterVariant('b'.repeat(64)));
});

test('promotes only adapter-QA-bound runtime bytes into the immutable platform layout', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'merge-catalog-promotion-'));
  try {
    const value = fixture(temp);
    const outputRoot = path.join(temp, 'out');
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const manifest = buildMergeCatalogRuntime({
      ...value,
      outputRoot,
      playablesRepo: path.resolve(repoRoot, '../playables'),
      sourceCommit,
    });
    const runtimeRoot = path.join(outputRoot, manifest.runtimeArtifactDigest.slice(7));
    const qaFile = path.join(runtimeRoot, manifest.adapterQaPath);
    mkdirSync(path.dirname(qaFile), { recursive: true });
    writeFileSync(qaFile, `${JSON.stringify({
      schema: 'merge.catalog-adapter-qa.v1',
      runtimeContractDigest: manifest.runtimeContractDigest,
      runtimeArtifactDigest: manifest.runtimeArtifactDigest,
      specHash: manifest.levelSpec.specHash,
      sourceHtmlSha256: manifest.sourceHtmlSha256,
      configured: true,
      completedCycle: true,
      gameplayEvents: [{ type: 'progress' }, { type: 'progress' }, { type: 'progress' }],
      externalRequestCount: 0,
      consoleErrorCount: 0,
      mountMs: 120,
    }, null, 2)}\n`);
    const platformRoot = path.join(temp, 'platform');
    mkdirSync(platformRoot);
    const checked = promoteMergeCatalogRuntime({ runtimeRoot, platformRoot });
    assert.equal(checked.status, 'would_create');
    assert.equal(checked.descriptor.mechanic, 'merge');
    assert.equal(checked.descriptor.variant, manifest.variant);
    assert.equal(checked.descriptor.sourceRepository, 'swipe-ugc');
    const created = promoteMergeCatalogRuntime({ runtimeRoot, platformRoot, mode: 'write' });
    const replayed = promoteMergeCatalogRuntime({ runtimeRoot, platformRoot, mode: 'write' });
    assert.equal(created.status, 'created');
    assert.equal(replayed.status, 'replayed');
    assert.deepEqual(replayed.descriptor, created.descriptor);
    const releaseRoot = path.join(platformRoot, created.target);
    assert.deepEqual(readdirSync(releaseRoot).sort(), ['index.html', 'runtime-artifact.json', 'runtime-release.json']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
