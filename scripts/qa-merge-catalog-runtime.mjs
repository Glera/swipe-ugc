#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

const options = { timeoutSeconds: 105 };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  if (name === '--runtime-root') options.runtimeRoot = path.resolve(value);
  else if (name === '--out') options.out = path.resolve(value);
  else if (name === '--timeout-seconds') options.timeoutSeconds = Number(value);
  else throw new Error(`unknown option ${name}`);
}
if (!options.runtimeRoot) throw new Error('--runtime-root is required');
if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 180) {
  throw new Error('--timeout-seconds must be between 1 and 180');
}

const manifestFile = path.join(options.runtimeRoot, 'catalog-runtime.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (manifest.schema !== 'merge.catalog-runtime-artifact.v1') {
  throw new Error('merge_catalog_adapter_manifest_invalid');
}
const runtimeRoot = path.join(options.runtimeRoot, 'runtime');
options.out = options.out || path.join(options.runtimeRoot, manifest.adapterQaPath || '');
if (options.out !== path.resolve(options.runtimeRoot, String(manifest.adapterQaPath || ''))) {
  throw new Error('merge_catalog_adapter_qa_output_mismatch');
}
const indexFile = path.join(runtimeRoot, 'index.html');
if (!statSync(indexFile).isFile()) throw new Error('merge_catalog_adapter_index_missing');

const hostHtml = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style><iframe id="game"></iframe><script>
  const spec=${JSON.stringify(manifest.levelSpec)};
  const frame=document.getElementById('game');
  window.__adapterMessages=[];
  window.__adapterStartedAt=performance.now();
  addEventListener('message',event=>{
    const data=event.data;
    window.__adapterMessages.push({at:performance.now(),data});
    if(data?.type==='configure_ready'){
      frame.contentWindow.postMessage({type:'configure_level',nonce:data.nonce,spec},event.origin);
    }else if(data?.type==='configured'){
      frame.contentWindow.postMessage({target:'playable-swipe',type:'prepareInteractive'},event.origin);
      frame.contentWindow.postMessage({target:'playable-swipe',type:'setHostPaused',paused:false},event.origin);
      frame.contentWindow.postMessage({target:'playable-swipe',type:'startAutoPlay'},event.origin);
    }
  });
  frame.src='/runtime/index.html?level_config=catalog_required&expected_spec_hash='+spec.specHash;
</script>`;

function safeFile(requestPath) {
  const relative = decodeURIComponent(requestPath).replace(/^\/runtime\//, '');
  const file = path.resolve(runtimeRoot, relative);
  if (!file.startsWith(`${runtimeRoot}${path.sep}`)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(hostHtml);
    return;
  }
  if (!pathname.startsWith('/runtime/')) {
    response.statusCode = 404;
    response.end();
    return;
  }
  const file = safeFile(pathname);
  if (!file) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader(
    'content-type',
    file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
  );
  response.end(readFileSync(file));
});

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const consoleErrors = [];
  const externalRequests = [];
  page.on('pageerror', error => consoleErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && url.protocol !== 'blob:') {
      externalRequests.push(url.href);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(
      () => window.__adapterMessages.filter(item => item.data?.type === 'progress').length >= 3,
      null,
      { timeout: options.timeoutSeconds * 1000 },
    );
  } catch (error) {
    const messages = await page.evaluate(() => window.__adapterMessages || []);
    throw new Error(`merge_catalog_adapter_cycle_timeout: messages=${JSON.stringify(messages.slice(-24))}; console=${JSON.stringify(consoleErrors.slice(-12))}; cause=${error.message}`);
  }
  const observed = await page.evaluate(() => ({
    startedAt: window.__adapterStartedAt,
    messages: window.__adapterMessages,
  }));
  const configured = observed.messages.find(item => item.data?.type === 'configured');
  const progress = observed.messages.filter(item => item.data?.type === 'progress').slice(0, 3);
  if (!configured
    || configured.data.appliedSpecHash !== manifest.levelSpec.specHash
    || configured.data.runtimeContractDigest !== manifest.runtimeContractDigest
    || configured.data.runtimeArtifactDigest !== manifest.runtimeArtifactDigest) {
    throw new Error('merge_catalog_adapter_configured_mismatch');
  }
  if (consoleErrors.length) {
    throw new Error(`merge_catalog_adapter_console_error: ${consoleErrors.slice(0, 8).join('; ')}`);
  }
  if (externalRequests.length) {
    throw new Error(`merge_catalog_adapter_external_request: ${externalRequests.slice(0, 8).join(', ')}`);
  }
  const mountMs = Math.max(0, Math.ceil(configured.at - observed.startedAt));
  if (mountMs > 15_000) throw new Error(`merge_catalog_adapter_mount_timeout: ${mountMs}`);
  const report = {
    schema: 'merge.catalog-adapter-qa.v1',
    runtimeContractDigest: manifest.runtimeContractDigest,
    runtimeArtifactDigest: manifest.runtimeArtifactDigest,
    specHash: manifest.levelSpec.specHash,
    sourceHtmlSha256: manifest.sourceHtmlSha256,
    configured: true,
    completedCycle: true,
    gameplayEvents: progress.map(() => ({ type: 'progress' })),
    externalRequestCount: 0,
    consoleErrorCount: 0,
    mountMs,
  };
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  await page.close();
} finally {
  await browser.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
