#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const options = { timeoutSeconds: 105 };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  if (name === '--artifact-root') options.artifactRoot = path.resolve(value);
  else if (name === '--baseline-runtime') options.baselineRuntime = path.resolve(value);
  else if (name === '--out') options.out = path.resolve(value);
  else if (name === '--timeout-seconds') options.timeoutSeconds = Number(value);
  else throw new Error(`unknown option ${name}`);
}
if (!options.artifactRoot || !options.baselineRuntime || !options.out) {
  throw new Error('--artifact-root, --baseline-runtime and --out are required');
}

const artifact = JSON.parse(readFileSync(path.join(options.artifactRoot, 'merge-artifact.json'), 'utf8'));
const candidateRoot = path.join(options.artifactRoot, 'runtime');
const roots = { candidate: candidateRoot, baseline: options.baselineRuntime };
const mime = (file) => file.endsWith('.html') ? 'text/html; charset=utf-8'
  : file.endsWith('.js') ? 'application/javascript; charset=utf-8'
    : file.endsWith('.json') ? 'application/json; charset=utf-8'
      : file.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
}

function validateRuntimeFiles() {
  const manifest = JSON.parse(readFileSync(path.join(candidateRoot, 'runtime-artifact.json'), 'utf8'));
  if (manifest.digest !== artifact.runtimeArtifactDigest) throw new Error('merge_art_qa_runtime_digest_mismatch');
  for (const entry of manifest.files) {
    const bytes = readFileSync(path.join(candidateRoot, entry.path));
    if (bytes.length !== entry.bytes || `sha256:${sha256(bytes)}` !== entry.sha256) {
      throw new Error(`merge_art_qa_runtime_file_mismatch: ${entry.path}`);
    }
  }
  return manifest;
}

const runtimeManifest = validateRuntimeFiles();
mkdirSync(options.out, { recursive: true });
const server = createServer((request, response) => {
  const match = decodeURIComponent((request.url || '/').split('?')[0]).match(/^\/(candidate|baseline)\/(.+)$/);
  if (!match) { response.statusCode = 404; response.end(); return; }
  const root = roots[match[1]];
  const file = path.resolve(root, match[2]);
  if (!file.startsWith(`${root}${path.sep}`) || !statSafe(file)) { response.statusCode = 404; response.end(); return; }
  response.setHeader('content-type', mime(file));
  response.end(readFileSync(file));
});
function statSafe(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

function normalizedGameplayEvents(events) {
  return events.flatMap((event) => {
    const type = String(event?.type || '');
    if (!/(progress|milestone|complet|won|win|lost|lose|retry)/i.test(type)) return [];
    const value = { type };
    for (const key of ['success', 'milestone', 'progress', 'level', 'value', 'reason']) {
      if (event[key] !== undefined) value[key] = event[key];
    }
    return [value];
  });
}

async function runOne(kind, viewport, screenshotName = '') {
  const page = await browser.newPage({ viewport });
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  await page.addInitScript((seed) => {
    window.__mergeQaEvents = [];
    window.__mergeQaHostSignals = [];
    window.PlayableHost = {
      quality: 'premium',
      perf: '0',
      ready() { window.__mergeQaHostSignals.push({ type: 'ready' }); },
      hideHud() { window.__mergeQaHostSignals.push({ type: 'hideHud' }); },
      win(value) { window.__mergeQaHostSignals.push({ type: 'win', success: true, value: value ?? null }); },
      lose(value) { window.__mergeQaHostSignals.push({ type: 'lose', success: false, value: value ?? null }); },
    };
    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object' && event.data.source === 'playable') {
        window.__mergeQaEvents.push(event.data);
      }
    });
    let state = Number(seed) >>> 0;
    Math.random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }, 0x4d455247);
  try {
    await page.goto(`${origin}/${kind}/index.html?seed=1296388679&perf=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 30000 });
    } catch (error) {
      throw new Error(`${kind} did not mount a visible canvas; pageErrors=${JSON.stringify(errors.slice(0, 8))}; external=${JSON.stringify(external.slice(0, 8))}; cause=${error.message}`);
    }
    await page.waitForFunction(() => window.__playable?.swipe?.hasAutoPlay === true, null, { timeout: 30000 });
    await page.evaluate(() => {
      window.postMessage({ target: 'playable-swipe', type: 'prepareInteractive' }, '*');
      window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: false }, '*');
    });
    await page.waitForTimeout(2600);
    if (screenshotName) await page.screenshot({ path: path.join(options.out, screenshotName), type: 'png' });
    await page.evaluate(() => window.__playable.swipe.startAutoPlay());
    const frameTimes = await page.evaluate(() => new Promise((resolvePromise) => {
      const values = [];
      let previous = performance.now();
      const frame = (now) => {
        values.push(now - previous);
        previous = now;
        if (values.length >= 240) resolvePromise(values.slice(1));
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    const deadline = Date.now() + options.timeoutSeconds * 1000;
    let events = [];
    let lastSwipe = null;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        events: window.__mergeQaEvents || [],
        signals: window.__mergeQaHostSignals || [],
        outcome: window.__playable?.getPlayableOutcome?.() ?? null,
        swipe: window.__playable?.getSwipeState?.() ?? null,
      }));
      events = [...state.events, ...state.signals];
      lastSwipe = state.swipe;
      if (state.outcome === 'win' || state.signals.some((event) => event.type === 'win')) break;
      if (state.outcome === 'lose' || state.signals.some((event) => event.type === 'lose')) break;
      // The SWIPE build deliberately loops its autoplay preview after a solved
      // run instead of emitting the manual-play WIN surface. A completed loop
      // is therefore the authoritative success signal for this mechanic.
      if ((state.swipe?.autoPreviewLoops || 0) >= 1 ||
          (state.swipe?.gameEnded === true && state.swipe?.ordersCompleted >= state.swipe?.ordersToWin)) break;
      await page.waitForTimeout(100);
    }
    const finalState = await page.evaluate(() => ({
      outcome: window.__playable?.getPlayableOutcome?.() ?? null,
      swipe: window.__playable?.getSwipeState?.() ?? null,
    }));
    const outcome = finalState.outcome;
    lastSwipe = finalState.swipe || lastSwipe;
    const completedCycle = outcome === 'win' ||
      events.some((event) => event.type === 'win' && event.success !== false) ||
      (lastSwipe?.autoPreviewLoops || 0) >= 1 ||
      (lastSwipe?.gameEnded === true && lastSwipe?.ordersCompleted >= lastSwipe?.ordersToWin);
    if (!completedCycle) throw new Error(`${kind}/${viewport.width}x${viewport.height} did not complete an autoplay cycle; outcome=${outcome}; swipe=${JSON.stringify(lastSwipe)}; events=${JSON.stringify(events.slice(-12))}`);
    if (errors.length) throw new Error(`${kind} console errors: ${errors.slice(0, 8).join('; ')}`);
    if (external.length) throw new Error(`${kind} external requests: ${external.slice(0, 8).join(', ')}`);
    return {
      kind,
      viewport,
      completedCycle,
      outcome,
      completionEvidence: {
        ordersToWin: lastSwipe?.ordersToWin ?? null,
        autoPreviewLoopObserved: (lastSwipe?.autoPreviewLoops || 0) >= 1,
        solvedStateObserved: lastSwipe?.gameEnded === true && lastSwipe?.ordersCompleted >= lastSwipe?.ordersToWin,
      },
      gameplayEvents: normalizedGameplayEvents(events),
      performance: {
        frames: frameTimes.length,
        medianFrameMs: Number(percentile(frameTimes, 0.5).toFixed(3)),
        p95FrameMs: Number(percentile(frameTimes, 0.95).toFixed(3)),
        longFrameRatio: Number((frameTimes.filter((value) => value > 50).length / frameTimes.length).toFixed(4)),
      },
    };
  } finally {
    await page.close();
  }
}

try {
  const portrait = { width: 390, height: 700 };
  const landscape = { width: 844, height: 390 };
  const baseline = await runOne('baseline', portrait);
  const candidatePortrait = await runOne('candidate', portrait, `${artifact.world.worldId}-portrait.png`);
  const candidateLandscape = await runOne('candidate', landscape, `${artifact.world.worldId}-landscape.png`);
  const baselineTrace = baseline.gameplayEvents;
  const candidateTrace = candidatePortrait.gameplayEvents;
  if (JSON.stringify(baselineTrace) !== JSON.stringify(candidateTrace)) {
    throw new Error(`merge_art_gameplay_trace_mismatch: ${JSON.stringify({ baselineTrace, candidateTrace })}`);
  }
  for (const result of [candidatePortrait, candidateLandscape]) {
    if (result.performance.medianFrameMs > 22 || result.performance.p95FrameMs > 50 || result.performance.longFrameRatio > 0.03) {
      throw new Error(`merge_art_performance_gate_failed: ${JSON.stringify(result.performance)}`);
    }
  }
  const report = {
    schema: 'merge.art-qa-report.v1',
    artPackHash: artifact.artPackHash,
    runtimeArtifactDigest: artifact.runtimeArtifactDigest,
    runtimeBytes: runtimeManifest.files.reduce((sum, file) => sum + file.bytes, 0),
    gameplayTerminalTraceEqual: true,
    runs: { baseline, candidatePortrait, candidateLandscape },
  };
  writeFileSync(path.join(options.out, 'qa-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
