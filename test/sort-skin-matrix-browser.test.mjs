import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { verifyRuntimeArtifact } from '../worker/runtime-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = path.join(root, 'bases', 'sort-v2-skins-qa');
const baseline = JSON.parse(readFileSync(path.join(baselineRoot, 'manifest.json'), 'utf8'));
const skins = JSON.parse(readFileSync(path.join(root, 'recipes/sort/skins/fixtures/manual-skins.v1.json'), 'utf8'));
const archetypes = JSON.parse(readFileSync(path.join(root, 'recipes/sort/skins/fixtures/skin-qa-archetypes.v1.json'), 'utf8')).archetypes;
const artifact = verifyRuntimeArtifact(baselineRoot);

function hostHtml(spec, skin) {
  const safeSpec = JSON.stringify(spec).replaceAll('<', '\\u003c');
  const safeSkin = JSON.stringify(skin).replaceAll('<', '\\u003c');
  return `<!doctype html><html><body style="margin:0">
<iframe id="game" src="/index.html?auto=0&vclock=1&oracle=1&level_config=catalog_required&expected_spec_hash=${spec.specHash}&expected_skin_hash=${skin.skinHash}" style="width:390px;height:700px;border:0"></iframe>
<script>
window.__events=[]; const game=document.getElementById('game');
const spec=${safeSpec}; const skin=${safeSkin};
window.addEventListener('message',(event)=>{
 if(event.source!==game.contentWindow)return; window.__events.push(event.data);
 if(event.data?.type==='configure_ready') game.contentWindow.postMessage({type:'configure_level',nonce:event.data.nonce,spec,skin},location.origin);
});
</script></body></html>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('immutable 5×6 skin matrix wins and preserves one gameplay report per archetype', { timeout: 180000 }, async () => {
  assert.equal(baseline.id, 'sort-v2-skins-qa');
  assert.equal(baseline.runtimeArtifactDigest, artifact.digest);
  assert.equal(baseline.capabilities.sortSkinSpecV1, true);
  assert.equal(archetypes.length, 5);
  assert.equal(skins.length, 6);

  let selectedSpec = null;
  let selectedSkin = null;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/host.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(hostHtml(selectedSpec, selectedSkin));
      return;
    }
    const relative = pathname === '/index.html' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'payload.js'].includes(relative)) {
      response.statusCode = 404; response.end(); return;
    }
    response.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(baselineRoot, relative)));
  });
  const origin = await listen(server);
  const browser = await chromium.launch();
  try {
    for (const archetype of archetypes) {
      let canonicalReport = null;
      const initialFrames = new Set();
      for (const candidate of skins) {
        selectedSpec = archetype.spec;
        selectedSkin = candidate.spec;
        const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${origin}/host.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__events.some((event) => event?.type === 'configured'), null, { timeout: 15000 });
        const frame = page.frames().find((item) => item.url().includes('/index.html'));
        assert.ok(frame, `${archetype.id}/${candidate.id} mounted`);
        await frame.waitForFunction(() => Boolean(window.__playable?.sortQa), null, { timeout: 5000 });
        const png = await frame.locator('canvas').screenshot();
        initialFrames.add(createHash('sha256').update(png).digest('hex'));
        await frame.evaluate(() => window.__playable.sortQa.advanceTicks(20000));
        const report = await frame.evaluate(() => window.__playable.sortQa.report());
        assert.equal(report.terminal, 'win', `${archetype.id}/${candidate.id}`);
        if (canonicalReport === null) canonicalReport = report;
        else assert.deepEqual(report, canonicalReport, `${archetype.id} gameplay drifted under ${candidate.id}`);
        assert.deepEqual(errors, [], `${archetype.id}/${candidate.id} emitted browser errors`);
        await page.close();
      }
      assert.equal(initialFrames.size, 6, `${archetype.id} must have six visibly distinct initial frames`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
