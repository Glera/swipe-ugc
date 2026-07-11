#!/usr/bin/env node
import { createServer } from 'http';
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { hardenExperimentHtml, installExternalNetworkDeny } from './hardening.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Math.max(30, Number(process.env.UGC_PREVIEW_TEST_TIMEOUT_SEC || 120)) * 1000;
const variant = {
  schemaVersion: 2,
  seed: 246813579,
  items: ['#E63946', '#2A9D8F', '#F4D35E', '#4361EE', '#F72585', '#90BE6D'],
  sceneBg: '#08090D',
  boardBg: '#151820',
  belt: '#282D38',
  outline: '#BFC7D5',
  difficulty: 'easy',
  motion: 'calm',
  marbleStyle: 'obsidian',
  markerStyle: 'glyphs',
  targetShape: 'hex',
  conveyorPath: 'compact',
  sourceShape: 'silo',
  backgroundPattern: 'grid',
};
const token = Buffer.from(JSON.stringify(variant)).toString('base64url');
const baseHtml = readFileSync(path.join(root, 'bases', 'sort-v2', 'index.html'), 'utf8');
const basePayload = readFileSync(path.join(root, 'bases', 'sort-v2', 'payload.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const hardenedHtml = hardenExperimentHtml(baseHtml.replace(
  '<script type="module" src="./payload.js"></script>',
  `<script type="module">${basePayload}</script>`,
));
const cspProbeHtml = hardenExperimentHtml('<!doctype html><html><head><script>new Image().src="https://example.invalid/exfiltrate"</script></head><body></body></html>');

const server = createServer((request, response) => {
  const pathname = decodeURIComponent((request.url || '/').split('?')[0]);
  if (pathname === '/test/hardened.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(hardenedHtml);
    return;
  }
  if (pathname === '/test/csp-probe.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(cspProbeHtml);
    return;
  }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errors = [];
  const externalAttempts = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await installExternalNetworkDeny(page, origin, externalAttempts);
  await page.addInitScript(() => {
    window.__previewEvents = [];
    window.__cspViolations = [];
    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object' && event.data.source === 'playable') {
        window.__previewEvents.push(event.data);
      }
    });
    window.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  });

  await page.goto(`${origin}/preview/sort-v2.html#invalid`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#preview-error', { state: 'visible' });
  if (await page.locator('canvas').count()) throw new Error('invalid preview config mounted the playable');

  errors.length = 0;
  externalAttempts.length = 0;
  await page.goto(`${origin}/test/csp-probe.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const blockedProbe = await page.evaluate(() => window.__cspViolations);
  if (!blockedProbe.some((violation) => violation.startsWith('img-src'))) throw new Error('network-deny CSP did not report the image exfiltration probe');
  if (!externalAttempts.length) throw new Error('Playwright network deny did not observe the image exfiltration attempt');
  externalAttempts.length = 0;

  errors.length = 0;
  await page.goto(`${origin}/test/hardened.html?auto=0&hostPaused=1&warmpaint=off`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 25000 });
  await page.waitForFunction(() => window.__previewEvents.some((event) => event.type === 'static_ready'));
  if (await page.evaluate(() => window.__previewEvents.some((event) => event.type === 'interactive_ready'))) {
    throw new Error('hardened artifact became interactive before host preparation');
  }
  await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'prepareInteractive' }, '*'));
  await page.waitForFunction(() => window.__previewEvents.some((event) => event.type === 'interactive_ready'));
  await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: false }, '*'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: true }, '*'));
  await page.waitForTimeout(350);
  const pauseA = createHash('sha1').update(await page.locator('canvas').screenshot()).digest('hex');
  await page.waitForTimeout(700);
  const pauseB = createHash('sha1').update(await page.locator('canvas').screenshot()).digest('hex');
  if (pauseA !== pauseB) throw new Error('hardened artifact kept painting while host-paused');
  const violations = await page.evaluate(() => window.__cspViolations);
  if (violations.length) throw new Error(`hardened artifact hit CSP violations: ${violations.join(', ')}`);

  errors.length = 0;
  await page.goto(`${origin}/preview/sort-v2.html?auto=1#${token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 25000 });
  await page.waitForFunction(() => window.__previewEvents.some((event) =>
    /complet|won|win/i.test(String(event?.type || '')) && event?.success === true), undefined, { timeout: timeoutMs });
  if (externalAttempts.length) throw new Error(`preview attempted external requests: ${externalAttempts.join(', ')}`);
  if (errors.length) throw new Error(`preview emitted errors:\n${errors.slice(0, 8).join('\n')}`);
  console.log('[preview-test] frozen sort base booted and autoplay reached WIN');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
