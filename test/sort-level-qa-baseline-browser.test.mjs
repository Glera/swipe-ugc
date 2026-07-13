import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'bases', 'sort-v2-levels-qa');
const fixture = JSON.parse(readFileSync(
  path.join(root, 'recipes', 'sort', 'levels', 'fixtures', 'sort-contract-golden.v1.json'),
  'utf8',
));
const spec = fixture.levelSpecs[0].spec;
const runtimeManifest = JSON.parse(readFileSync(path.join(artifactRoot, 'runtime-artifact.json'), 'utf8'));

function hostHtml() {
  const safeSpec = JSON.stringify(spec).replaceAll('<', '\\u003c');
  const src = `/index.html?auto=0&vclock=1&oracle=1&level_config=catalog_required&expected_spec_hash=${spec.specHash}`;
  return `<!doctype html><html><body>
<iframe id="game" src="${src}" style="width:390px;height:700px;border:0"></iframe>
<script>
window.__events=[];
const game=document.getElementById('game');
const spec=${safeSpec};
window.addEventListener('message',(event)=>{
  if(event.source!==game.contentWindow)return;
  window.__events.push(event.data);
  if(event.data&&event.data.type==='configure_ready'){
    game.contentWindow.postMessage({type:'configure_level',nonce:event.data.nonce,spec},location.origin);
  }
});
</script></body></html>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('packaged Sort QA baseline mounts its pinned digest and reproduces the oracle golden trace', { timeout: 60000 }, async () => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/host.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(hostHtml());
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(readFileSync(path.join(artifactRoot, 'index.html')));
      return;
    }
    if (pathname === '/payload.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(readFileSync(path.join(artifactRoot, 'payload.js')));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const origin = await listen(server);
  const browser = await chromium.launch();
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 760 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/host.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__events.some((event) => event?.type === 'configured'), null, { timeout: 15000 });
    const ready = await page.evaluate(() => window.__events.find((event) => event?.type === 'configure_ready'));
    assert.equal(ready.runtimeArtifactDigest, runtimeManifest.digest);
    assert.equal(ready.runtimeContractDigest, fixture.runtimeContract.sha256);

    const frame = page.frames().find((candidate) => candidate.url().includes('/index.html'));
    assert.ok(frame, 'catalog iframe mounted');
    await frame.waitForFunction(() => Boolean(window.__playable?.sortQa), null, { timeout: 5000 });
    await frame.evaluate(() => window.__playable.sortQa.advanceTicks(1600));
    const report = await frame.evaluate(() => window.__playable.sortQa.report());
    assert.deepEqual({
      ticks: report.ticks,
      boardHash: report.boardHash,
      fingerprint: report.fingerprint,
      actions: report.actions,
      decisionPoints: report.decisionPoints,
      recoveryTicks: report.recoveryTicks,
      terminal: report.terminal,
      actionCells: report.actionTrace.map((step) => step.action.cellId),
    }, {
      ticks: 1600,
      boardHash: '89260dd1ad1642c999456019034073ec167e06794732416acff5ed4126ccb937',
      fingerprint: '8e69981b7882116f12103fdfd49bfacbaac4420c34fc1ad24fccb0a2c45f7b9c',
      actions: 6,
      decisionPoints: 130,
      recoveryTicks: 515,
      terminal: 'win',
      actionCells: [48, 50, 40, 49, 51, 41],
    });
    assert.deepEqual(pageErrors, []);
    await page.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
