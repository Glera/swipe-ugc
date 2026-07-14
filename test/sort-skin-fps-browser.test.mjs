import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = path.join(root, 'bases', 'sort-v2-skins-qa');
const skins = JSON.parse(readFileSync(path.join(root, 'recipes/sort/skins/fixtures/manual-skins.v1.json'), 'utf8'));
const archetypes = JSON.parse(readFileSync(path.join(root, 'recipes/sort/skins/fixtures/skin-qa-archetypes.v1.json'), 'utf8')).archetypes;
const policy = JSON.parse(readFileSync(path.join(root, 'recipes/sort/skins/sort.skin-qa-policy.v1.json'), 'utf8'));
const spec = archetypes.find(({ id }) => id === 'dense-grid').spec;

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function hostHtml(skin) {
  return `<!doctype html><html><body style="margin:0"><iframe id="game" src="/index.html?auto=0&level_config=catalog_required&expected_spec_hash=${spec.specHash}&expected_skin_hash=${skin.skinHash}" style="width:390px;height:700px;border:0"></iframe><script>
window.__events=[];const game=document.getElementById('game');const spec=${JSON.stringify(spec)};const skin=${JSON.stringify(skin)};
window.addEventListener('message',(event)=>{if(event.source!==game.contentWindow)return;window.__events.push(event.data);if(event.data?.type==='configure_ready')game.contentWindow.postMessage({type:'configure_level',nonce:event.data.nonce,spec,skin},location.origin);});
</script></body></html>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('all six skins stay inside the frozen weak-profile frame budget', {
  timeout: 120000,
  skip: process.env.RUN_SORT_SKIN_FPS !== '1',
}, async () => {
  let selectedSkin = null;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/host.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(hostHtml(selectedSkin)); return;
    }
    const relative = pathname === '/index.html' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'payload.js'].includes(relative)) { response.statusCode = 404; response.end(); return; }
    response.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(baselineRoot, relative)));
  });
  const origin = await listen(server);
  const browser = await chromium.launch();
  try {
    for (const candidate of skins) {
      selectedSkin = candidate.spec;
      const page = await browser.newPage({
        viewport: policy.viewport,
        deviceScaleFactor: policy.deviceScaleFactor,
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: policy.cpuThrottlingRate });
      await page.goto(`${origin}/host.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__events.some((event) => event?.type === 'configured'), null, { timeout: 15000 });
      const frame = page.frames().find((item) => item.url().includes('/index.html'));
      assert.ok(frame);
      const intervals = await frame.evaluate(async ({ warmupFrames, sampleFrames }) => {
        const values = [];
        let previous = performance.now();
        for (let index = 0; index < warmupFrames + sampleFrames; index += 1) {
          const now = await new Promise((resolve) => requestAnimationFrame(resolve));
          if (index >= warmupFrames) values.push(now - previous);
          previous = now;
        }
        return values;
      }, policy);
      const sorted = [...intervals].sort((left, right) => left - right);
      const median = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      const longRatio = intervals.filter((value) => value > policy.thresholds.longFrameMs).length / intervals.length;
      assert.ok(median <= policy.thresholds.medianFrameMsMax, `${candidate.id} median ${median}`);
      assert.ok(p95 <= policy.thresholds.p95FrameMsMax, `${candidate.id} p95 ${p95}`);
      assert.ok(longRatio <= policy.thresholds.longFrameRatioMax, `${candidate.id} long ratio ${longRatio}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
