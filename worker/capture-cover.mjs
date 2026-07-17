#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { assertHardenedExperimentHtml, hardenExperimentHtml, installExternalNetworkDeny } from './hardening.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRoot = path.join(repoRoot, '.local-experiments');
const artifactRoot = path.join(repoRoot, 'u', 'local-experiments');
const requestedId = process.argv[process.argv.indexOf('--id') + 1];
const all = process.argv.includes('--all');
const validId = (value) => /^[a-z0-9-]{8,80}$/.test(String(value || ''));
const ids = all
  ? readdirSync(localRoot).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter(validId)
  : validId(requestedId) ? [requestedId] : [];
if (!ids.length) throw new Error('pass --id <experiment-id> or --all');

const server = createServer((request, response) => {
  const match = decodeURIComponent((request.url || '/').split('?')[0]).match(/^\/([a-z0-9-]{8,80})\.html$/);
  const file = match ? path.join(artifactRoot, `${match[1]}.html`) : '';
  if (!file || !existsSync(file) || !statSync(file).isFile()) { response.statusCode = 404; response.end(); return; }
  try {
    const html = hardenExperimentHtml(readFileSync(file, 'utf8'));
    assertHardenedExperimentHtml(html);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  for (const id of ids) {
    const artifact = path.join(artifactRoot, `${id}.html`);
    const manifestPath = path.join(localRoot, `${id}.json`);
    if (!existsSync(artifact) || !existsSync(manifestPath)) continue;
    // Typed worker results are content-addressed: the committed cover is part
    // of the artifact identity and the manifest is digest-sealed. Re-capturing
    // would silently break both, so those candidates are immutable here.
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (committed?.schema === 'ugc.experiment-worker-result.v1') {
      console.log(`[cover] ${id}: skipped (content-addressed typed result is immutable)`);
      continue;
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const errors = [];
    const externalAttempts = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await installExternalNetworkDeny(page, origin, externalAttempts);
    await page.addInitScript(() => {
      window.__coverEvents = [];
      window.addEventListener('message', (event) => {
        if (event.data && typeof event.data === 'object' && event.data.source === 'playable') window.__coverEvents.push(event.data);
      });
    });
    try {
      await page.goto(`${origin}/${id}.html?auto=0&hostPaused=1&warmpaint=off`, { waitUntil: 'domcontentloaded' });
      const canvas = page.locator('canvas');
      await canvas.waitFor({ state: 'visible', timeout: 25000 });
      await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'prepareInteractive' }, '*'));
      await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: false }, '*'));
      await page.waitForTimeout(1600);
      const box = await canvas.boundingBox();
      if (!box || box.width < 100 || box.height < 100) throw new Error(`${id}: canvas is not visibly sized`);
      await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.24 } });
      await page.waitForTimeout(900);
      const coverAspect = 16 / 9;
      const height = Math.min(box.height, box.width / coverAspect);
      const width = Math.min(box.width, height * coverAspect);
      const cover = await page.screenshot({
        type: 'png',
        clip: { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height },
      });
      if (errors.length) throw new Error(`${id}: ${errors.slice(0, 5).join('; ')}`);
      if (externalAttempts.length) throw new Error(`${id}: external requests: ${externalAttempts.slice(0, 5).join(', ')}`);
      const coverPath = path.join(artifactRoot, `${id}.cover.png`);
      writeFileSync(coverPath, cover);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.coverUrl = `/ugc/u/local-experiments/${id}.cover.png`;
      manifest.coverBytes = cover.length;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`[cover] ${id}: ${cover.length} bytes`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
