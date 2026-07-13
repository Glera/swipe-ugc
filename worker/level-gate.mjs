#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  canonicalize,
  runtimeContractDigest,
  sha256Jcs,
  validateLevelSpec,
} from '../recipes/sort/levels/index.mjs';
import {
  GUIDED_CSP,
  installExternalNetworkDeny,
} from './hardening.mjs';
import {
  isSha256Digest,
  sha256File,
  verifyRuntimeArtifact,
} from './runtime-artifact.mjs';
import {
  scoreSortOracleEffort,
  validateSortOracleReport,
} from './sort-oracle-effort.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

export const LEVEL_GATE_REQUEST_SCHEMA = 'sort.level-gate-request.v1';
export const LEVEL_GATE_RESULT_SCHEMA = 'sort.level-gate-result.v1';
export const LEVEL_GATE_BASELINE_ID = 'sort-v2-levels-qa';
export const EXPECTED_ORACLE_VERSION = 'sort.oracle.v1';
export const LEVEL_GATE_STDIN_LIMIT = 256 * 1024;

export const LEVEL_GATE_ORACLE_VERSION = Object.freeze({
  schema: 'sort.oracle-version.v1',
  mechanic: 'sort',
  runtimeQaApiVersion: 1,
  reportSchema: 'sort.logical-qa-report.v1',
});
export const LEVEL_GATE_ORACLE_VERSION_DIGEST = `sha256:${sha256Jcs(LEVEL_GATE_ORACLE_VERSION)}`;

export const LEVEL_GATE_POLICY = Object.freeze({
  schema: 'sort.level-gate-policy.v1',
  viewport: Object.freeze({ width: 430, height: 760 }),
  mountTimeoutMs: 15000,
  maxVclockTicks: 20000,
  minWinTicks: 180,
  minVisualStates: 2,
  realtimeTimeoutMs: 45000,
  browserEngine: 'chromium',
  browserHeadless: true,
});

export const LEVEL_GATE_POLICY_DIGEST = `sha256:${sha256Jcs(LEVEL_GATE_POLICY)}`;

const BASELINE_CAPABILITIES = Object.freeze([
  'catalogRequiredHandshake',
  'logicalScheduler',
  'oracleQa',
  'realtimeOracleSmoke',
  'sortLevelSpecV1',
  'virtualClockQa',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must exactly contain ${wanted.join(', ')}`);
  }
}

function boundedString(value, label, max) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) throw new Error(`${label} is invalid`);
  return value;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function summary(report) {
  return {
    schema: report.schema,
    specHash: report.specHash,
    epoch: report.epoch,
    ticks: report.ticks,
    boardHash: report.boardHash,
    fingerprint: report.fingerprint,
    actions: report.actions,
    decisionPoints: report.decisionPoints,
    recoveryTicks: report.recoveryTicks,
    terminal: report.terminal,
    actionTrace: report.actionTrace,
  };
}

function assertReport(report, specHash) {
  if (!report || report.schema !== 'sort.logical-qa-report.v1' || report.specHash !== specHash) {
    throw new Error('logical QA report has the wrong schema or specHash');
  }
  for (const key of ['ticks', 'actions', 'decisionPoints', 'recoveryTicks']) {
    if (!Number.isSafeInteger(report[key]) || report[key] < 0) throw new Error(`logical QA report has invalid ${key}`);
  }
  if (!SHA256_HEX.test(String(report.boardHash || '')) || !SHA256_HEX.test(String(report.fingerprint || ''))) {
    throw new Error('logical QA report has invalid hashes');
  }
  if (!['running', 'win', 'loss'].includes(report.terminal)) throw new Error('logical QA report has invalid terminal state');
  validateSortOracleReport(report, 'logical QA report');
  return report;
}

function normalizeRequest(value) {
  exactKeys(value, ['schema', 'childId', 'leaseToken', 'baseline', 'spec'], 'level gate request');
  if (value.schema !== LEVEL_GATE_REQUEST_SCHEMA) throw new Error('unsupported level gate request schema');
  const childId = boundedString(value.childId, 'childId', 180);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(childId)) throw new Error('childId is invalid');
  const leaseToken = boundedString(value.leaseToken, 'leaseToken', 36).toLowerCase();
  if (!UUID.test(leaseToken)) throw new Error('leaseToken must be a UUID');
  exactKeys(value.baseline, [
    'id',
    'manifestSha256',
    'runtimeArtifactDigest',
    'runtimeContractDigest',
    'sourceCommit',
    'sourceTree',
  ], 'QA baseline pin');
  const baseline = {
    id: boundedString(value.baseline.id, 'baseline id', 80),
    manifestSha256: boundedString(value.baseline.manifestSha256, 'baseline manifest digest', 71),
    runtimeArtifactDigest: boundedString(value.baseline.runtimeArtifactDigest, 'runtime artifact digest', 71),
    runtimeContractDigest: boundedString(value.baseline.runtimeContractDigest, 'runtime contract digest', 64),
    sourceCommit: boundedString(value.baseline.sourceCommit, 'baseline source commit', 40),
    sourceTree: boundedString(value.baseline.sourceTree, 'baseline source tree', 40),
  };
  if (baseline.id !== LEVEL_GATE_BASELINE_ID) throw new Error(`level gate requires baseline ${LEVEL_GATE_BASELINE_ID}`);
  if (!isSha256Digest(baseline.manifestSha256) || !isSha256Digest(baseline.runtimeArtifactDigest)) {
    throw new Error('baseline artifact digests must use lowercase sha256');
  }
  if (!SHA256_HEX.test(baseline.runtimeContractDigest)) throw new Error('runtimeContractDigest must be lowercase SHA-256');
  if (baseline.runtimeContractDigest !== runtimeContractDigest) {
    throw new Error('QA baseline pin is incompatible with the canonical Sort runtime contract');
  }
  if (!GIT_OBJECT.test(baseline.sourceCommit) || !GIT_OBJECT.test(baseline.sourceTree)) {
    throw new Error('baseline source commit/tree are invalid');
  }
  let encodedSpec;
  try { encodedSpec = JSON.stringify(value.spec); } catch { throw new Error('LevelSpec must be JSON'); }
  if (!encodedSpec || Buffer.byteLength(encodedSpec) > 64 * 1024) throw new Error('LevelSpec must be bounded JSON');
  const checked = validateLevelSpec(value.spec);
  if (!checked.ok) throw new Error(`invalid Sort LevelSpec: ${checked.errors.map((error) => error.code).join(', ')}`);
  if (value.spec.runtimeContractDigest !== baseline.runtimeContractDigest) {
    throw new Error('LevelSpec runtime contract differs from the QA baseline pin');
  }
  return Object.freeze({
    schema: LEVEL_GATE_REQUEST_SCHEMA,
    childId,
    leaseToken,
    baseline: Object.freeze(baseline),
    spec: structuredClone(value.spec),
  });
}

function verifyBaseline(request, basesRoot) {
  const root = path.resolve(String(basesRoot || ''), request.baseline.id);
  const resolvedBases = path.resolve(String(basesRoot || ''));
  if (!root.startsWith(`${resolvedBases}${path.sep}`)) throw new Error('QA baseline path escaped its trusted root');
  const manifestFile = path.join(root, 'manifest.json');
  if (sha256File(manifestFile) !== request.baseline.manifestSha256) {
    throw new Error('QA baseline manifest differs from the job pin');
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (
    manifest?.schemaVersion !== 1
    || manifest.id !== request.baseline.id
    || manifest.sourceCommit !== request.baseline.sourceCommit
    || manifest.sourceTree !== request.baseline.sourceTree
    || manifest.runtimeArtifactDigest !== request.baseline.runtimeArtifactDigest
    || manifest.runtimeContractDigest !== request.baseline.runtimeContractDigest
    || manifest.releasePlayable !== false
  ) throw new Error('QA baseline manifest differs from its immutable snapshot');
  exactKeys(manifest.capabilities, BASELINE_CAPABILITIES, 'QA baseline capabilities');
  for (const name of BASELINE_CAPABILITIES) {
    if (manifest.capabilities[name] !== true) throw new Error(`QA baseline capability ${name} is not enabled`);
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('QA baseline file manifest is invalid');
  }
  const runtime = verifyRuntimeArtifact(root, { expectedDigest: request.baseline.runtimeArtifactDigest });
  const expectedFiles = [...runtime.executablePaths, 'runtime-artifact.json'].sort();
  const declaredFiles = Object.keys(manifest.files).sort();
  if (JSON.stringify(declaredFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('QA baseline wrapper file set differs from the runtime sidecar');
  }
  for (const relative of declaredFiles) {
    if (sha256File(path.join(root, relative)) !== manifest.files[relative]) {
      throw new Error(`QA baseline wrapper hash mismatch: ${relative}`);
    }
  }
  if (runtime.manifest.sourceCommit !== request.baseline.sourceCommit) {
    throw new Error('runtime sidecar source commit differs from the QA baseline');
  }
  if (!runtime.executablePaths.includes('index.html')) throw new Error('QA runtime has no index.html');
  return Object.freeze({ root, manifest, runtime });
}

function gateSourceVersion() {
  const files = [
    'recipes/sort/levels/contract.mjs',
    'recipes/sort/levels/jcs.mjs',
    'recipes/sort/levels/sort.level-spec.v1.schema.json',
    'recipes/sort/levels/sort.runtime-contract.v1.json',
    'worker/hardening.mjs',
    'worker/level-gate.mjs',
    'worker/runtime-artifact.mjs',
    'worker/sort-oracle-effort.mjs',
  ].sort();
  const hash = createHash('sha256');
  hash.update(Buffer.from('swipe.sort-level-gate.source.v1\0'));
  for (const relative of files) {
    const bytes = readFileSync(path.join(repoRoot, relative));
    const name = Buffer.from(relative, 'utf8');
    const nameLength = Buffer.alloc(4);
    const byteLength = Buffer.alloc(8);
    nameLength.writeUInt32BE(name.length);
    byteLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(nameLength).update(name).update(byteLength).update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function sha256Stream(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

let identityPromise = null;
export function resolveGateIdentity() {
  if (!identityPromise) identityPromise = (async () => {
    const playwrightPackageFile = require.resolve('playwright/package.json');
    const playwrightCoreFile = require.resolve('playwright-core/package.json');
    const playwrightPackage = JSON.parse(readFileSync(playwrightPackageFile, 'utf8'));
    const browsers = JSON.parse(readFileSync(path.join(path.dirname(playwrightCoreFile), 'browsers.json'), 'utf8'));
    const chromiumDescriptor = browsers.browsers.find((entry) => entry.name === 'chromium');
    if (!chromiumDescriptor) throw new Error('Playwright Chromium descriptor is unavailable');
    const executable = chromium.executablePath();
    const browserDescriptor = {
      schema: 'swipe.browser-runtime.v1',
      engine: 'chromium',
      playwrightVersion: playwrightPackage.version,
      browserRevision: String(chromiumDescriptor.revision),
      browserVersion: String(chromiumDescriptor.browserVersion || ''),
      executableSha256: await sha256Stream(executable),
    };
    return Object.freeze({
      gateVersion: gateSourceVersion(),
      policyDigest: LEVEL_GATE_POLICY_DIGEST,
      browserRuntimeDigest: `sha256:${sha256Jcs(browserDescriptor)}`,
      platform: `${platform()}-${arch()}-${release()}`,
      oracleVersion: LEVEL_GATE_ORACLE_VERSION_DIGEST,
      browserDescriptor: Object.freeze(browserDescriptor),
    });
  })();
  return identityPromise;
}

function contentType(relative) {
  if (relative.endsWith('.html')) return 'text/html; charset=utf-8';
  if (relative.endsWith('.js') || relative.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (relative.endsWith('.json')) return 'application/json; charset=utf-8';
  if (relative.endsWith('.css')) return 'text/css; charset=utf-8';
  if (relative.endsWith('.png')) return 'image/png';
  if (relative.endsWith('.webp')) return 'image/webp';
  if (relative.endsWith('.svg')) return 'image/svg+xml';
  if (relative.endsWith('.mp4')) return 'video/mp4';
  if (relative.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

function hostHtml(spec, baseline) {
  const encodedSpec = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const values = JSON.stringify({
    specHash: spec.specHash,
    runtimeArtifactDigest: baseline.runtimeArtifactDigest,
    runtimeContractDigest: baseline.runtimeContractDigest,
  });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="game" style="width:390px;height:700px;border:0"></iframe>
<script>
const expected=${values};
const spec=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(encodedSpec)}),c=>c.charCodeAt(0))));
const mode=new URLSearchParams(location.search).get('mode')==='realtime'?'realtime':'vclock';
const game=document.getElementById('game');
const query=new URLSearchParams({auto:'0',vclock:mode==='vclock'?'1':'0',oracle:'1',level_config:'catalog_required',expected_spec_hash:expected.specHash});
window.__levelGateHost={events:[],protocolErrors:[],violations:[],startedAt:performance.now(),configuredAt:null,configured:false};
const exact=(value,keys)=>JSON.stringify(Object.keys(value||{}).sort())===JSON.stringify([...keys].sort());
window.addEventListener('message',event=>{
  if(event.source!==game.contentWindow)return;
  const data=event.data;
  if(data&&data.__levelGateViolation){window.__levelGateHost.violations.push(String(data.value||''));return;}
  if(!data||typeof data!=='object')return;
  window.__levelGateHost.events.push(data);
  if(data.type==='configure_ready'){
    if(!exact(data,['type','nonce','runtimeContractDigest','runtimeArtifactDigest'])
      ||!/^[0-9a-f]{32}$/.test(String(data.nonce||''))
      ||data.runtimeContractDigest!==expected.runtimeContractDigest
      ||data.runtimeArtifactDigest!==expected.runtimeArtifactDigest){
      window.__levelGateHost.protocolErrors.push('configure_ready mismatch');return;
    }
    game.contentWindow.postMessage({type:'configure_level',nonce:data.nonce,spec},location.origin);
  }
  if(data.type==='configured'){
    if(!exact(data,['type','appliedSpecHash','runtimeContractDigest','runtimeArtifactDigest'])
      ||data.appliedSpecHash!==expected.specHash
      ||data.runtimeContractDigest!==expected.runtimeContractDigest
      ||data.runtimeArtifactDigest!==expected.runtimeArtifactDigest){
      window.__levelGateHost.protocolErrors.push('configured mismatch');return;
    }
    window.__levelGateHost.configured=true;
    window.__levelGateHost.configuredAt=performance.now();
  }
  if(data.type==='configure_failed')window.__levelGateHost.protocolErrors.push('runtime configure_failed:'+String(data.reason||''));
});
game.src='/artifact/index.html?'+query.toString();
</script></body></html>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function withExactArtifactServer(bundle, spec, baseline, run) {
  const allowed = new Set(bundle.runtime.executablePaths);
  const host = hostHtml(spec, baseline);
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/host.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'");
      response.setHeader('cache-control', 'no-store');
      response.end(host);
      return;
    }
    if (url.pathname.startsWith('/artifact/')) {
      let relative;
      try { relative = decodeURIComponent(url.pathname.slice('/artifact/'.length)); } catch { relative = ''; }
      if (allowed.has(relative)) {
        response.setHeader('content-type', contentType(relative));
        response.setHeader('content-security-policy', GUIDED_CSP);
        response.setHeader('cache-control', 'no-store');
        response.end(readFileSync(path.join(bundle.root, relative)));
        return;
      }
    }
    response.statusCode = 404;
    response.end();
  });
  const origin = await listen(server);
  try { return await run(origin); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function openConfiguredRun(browser, origin, mode, specHash) {
  const context = await browser.newContext({ viewport: LEVEL_GATE_POLICY.viewport });
  const page = await context.newPage();
  const errors = [];
  const externalAttempts = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await installExternalNetworkDeny(page, origin, externalAttempts);
  await page.addInitScript(() => {
    window.__levelGateRafFrames = 0;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => nativeRaf((time) => {
      window.__levelGateRafFrames += 1;
      callback(time);
    });
    window.addEventListener('securitypolicyviolation', (event) => {
      if (window.top && window.top !== window) {
        window.top.postMessage({ __levelGateViolation: true, value: `${event.effectiveDirective}:${event.blockedURI}` }, '*');
      }
    });
  });
  await page.goto(`${origin}/host.html?mode=${mode}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => {
      const state = window.__levelGateHost;
      return state?.configured || state?.protocolErrors?.length > 0;
    }, null, { timeout: LEVEL_GATE_POLICY.mountTimeoutMs });
  } catch (error) {
    await context.close();
    throw new Error(`catalog handshake timed out: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hostState = await page.evaluate(() => window.__levelGateHost);
  if (!hostState.configured || hostState.protocolErrors.length) {
    await context.close();
    throw new Error(`catalog handshake failed: ${hostState.protocolErrors.join(', ')}`);
  }
  const frame = page.frames().find((candidate) => candidate.url().includes('/artifact/index.html'));
  if (!frame) {
    await context.close();
    throw new Error('catalog runtime iframe is unavailable');
  }
  try {
    await frame.waitForFunction(() => Boolean(window.__playable?.sortQa), null, { timeout: 5000 });
  } catch (error) {
    await context.close();
    throw new Error(`logical QA API is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const qa = await frame.evaluate(() => ({
    version: window.__playable.sortQa.version,
    virtualClock: window.__playable.sortQa.virtualClock,
    oracle: window.__playable.sortQa.oracle,
  }));
  if (qa.version !== 1 || qa.oracle !== true || qa.virtualClock !== (mode === 'vclock')) {
    await context.close();
    throw new Error('logical QA API does not match the requested clock/oracle mode');
  }
  if (await frame.locator('canvas').count() !== 1) {
    await context.close();
    throw new Error('configured QA runtime must expose exactly one canvas');
  }
  return {
    context,
    page,
    frame,
    errors,
    externalAttempts,
    mountMs: Math.max(0, Math.round(hostState.configuredAt - hostState.startedAt)),
    oracleVersion: `sort.oracle.v${qa.version}`,
    specHash,
  };
}

async function assertClean(run) {
  const host = await run.page.evaluate(() => window.__levelGateHost);
  if (run.externalAttempts.length) throw new Error(`QA runtime attempted external network: ${run.externalAttempts.slice(0, 8).join(', ')}`);
  if (host.violations.length) throw new Error(`QA runtime violated CSP: ${host.violations.slice(0, 8).join(', ')}`);
  if (run.errors.length) throw new Error(`QA runtime emitted errors: ${run.errors.slice(0, 8).join('\n')}`);
}

async function runVclockOracle(browser, origin, specHash) {
  const run = await openConfiguredRun(browser, origin, 'vclock', specHash);
  try {
    const before = sha256Bytes(await run.frame.locator('canvas').screenshot());
    const report = await run.frame.evaluate(async (maxTicks) => {
      const qa = window.__playable.sortQa;
      let state = qa.snapshot();
      let advanced = 0;
      while (state && !state.counters?.gameEnded && advanced < maxTicks) {
        state = qa.advanceTicks(1);
        advanced += 1;
      }
      return qa.report();
    }, LEVEL_GATE_POLICY.maxVclockTicks);
    assertReport(report, specHash);
    const after = sha256Bytes(await run.frame.locator('canvas').screenshot());
    await assertClean(run);
    return {
      report,
      summary: summary(report),
      mountMs: run.mountMs,
      oracleVersion: run.oracleVersion,
      visualStates: new Set([before, after]).size,
    };
  } finally {
    await run.context.close();
  }
}

async function runRealtimeSmoke(browser, origin, specHash) {
  const run = await openConfiguredRun(browser, origin, 'realtime', specHash);
  let timedOut = false;
  try {
    try {
      await run.frame.waitForFunction(() => window.__playable.sortQa.snapshot().counters?.gameEnded === true, null, {
        timeout: LEVEL_GATE_POLICY.realtimeTimeoutMs,
      });
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
      timedOut = true;
    }
    const report = await run.frame.evaluate(() => window.__playable.sortQa.report());
    assertReport(report, specHash);
    await assertClean(run);
    return {
      report,
      summary: summary(report),
      mountMs: run.mountMs,
      oracleVersion: run.oracleVersion,
      timedOut,
    };
  } finally {
    await run.context.close();
  }
}

export function classifyLevelRuns(first, second, realtime = null) {
  if (first.oracleVersion !== EXPECTED_ORACLE_VERSION || second.oracleVersion !== EXPECTED_ORACLE_VERSION) {
    return { verdict: 'flake', reason: 'oracle_version_mismatch' };
  }
  if (canonicalize(first.report) !== canonicalize(second.report)) {
    return { verdict: 'flake', reason: 'vclock_report_mismatch' };
  }
  if (first.report.terminal !== 'win') return { verdict: 'inconclusive', reason: 'oracle_did_not_win' };
  if (first.report.ticks < LEVEL_GATE_POLICY.minWinTicks
    || first.visualStates < LEVEL_GATE_POLICY.minVisualStates
    || second.visualStates < LEVEL_GATE_POLICY.minVisualStates) {
    return { verdict: 'inconclusive', reason: 'degenerate_win' };
  }
  if (!realtime) return { verdict: 'pass', reason: 'vclock_pass' };
  if (realtime.oracleVersion !== EXPECTED_ORACLE_VERSION
    || realtime.timedOut
    || realtime.report.terminal !== 'win') {
    return { verdict: 'flake', reason: 'realtime_smoke_mismatch' };
  }
  return { verdict: 'pass', reason: 'verified' };
}

function environmentIdentity(identity, request) {
  const cacheIdentity = {
    schema: 'sort.level-qa-cache-key.v1',
    specHash: request.spec.specHash,
    runtimeArtifactDigest: request.baseline.runtimeArtifactDigest,
    gateVersion: identity.gateVersion,
    browserRuntimeDigest: identity.browserRuntimeDigest,
    platform: identity.platform,
    oracleVersion: identity.oracleVersion,
    policyDigest: identity.policyDigest,
  };
  return Object.freeze({
    ...cacheIdentity,
    cacheKey: `sha256:${sha256Jcs(cacheIdentity)}`,
  });
}

export async function evaluateSortLevel(rawRequest, {
  basesRoot = process.env.SWIPE_LEVEL_GATE_BASES_ROOT || path.join(repoRoot, 'bases'),
  onStatus = () => {},
} = {}) {
  const request = normalizeRequest(rawRequest);
  onStatus({ phase: 'qa-verify', message: 'Verifying pinned logical QA runtime' });
  const bundle = verifyBaseline(request, basesRoot);
  const identity = await resolveGateIdentity();
  const environment = environmentIdentity(identity, request);
  onStatus({ phase: 'qa-vclock', message: 'Running two independent logical-clock oracle passes' });

  return withExactArtifactServer(bundle, request.spec, request.baseline, async (origin) => {
    const browser = await chromium.launch({ headless: LEVEL_GATE_POLICY.browserHeadless });
    try {
      const first = await runVclockOracle(browser, origin, request.spec.specHash);
      const second = await runVclockOracle(browser, origin, request.spec.specHash);
      let classification = classifyLevelRuns(first, second);
      let realtime = null;
      if (classification.verdict === 'pass') {
        onStatus({ phase: 'qa-realtime', message: 'Running production-clock oracle smoke' });
        realtime = await runRealtimeSmoke(browser, origin, request.spec.specHash);
        classification = classifyLevelRuns(first, second, realtime);
      }
      const difficulty = scoreSortOracleEffort({
        firstReport: first.report,
        secondReport: second.report,
        firstOracleVersion: first.oracleVersion,
        secondOracleVersion: second.oracleVersion,
      });
      return {
        schema: LEVEL_GATE_RESULT_SCHEMA,
        childId: request.childId,
        leaseToken: request.leaseToken,
        specHash: request.spec.specHash,
        baseline: request.baseline,
        environment,
        verdict: classification.verdict,
        reason: classification.reason,
        difficulty,
        metrics: {
          ticks: first.report.ticks,
          actions: first.report.actions,
          decisionPoints: first.report.decisionPoints,
          recoveryTicks: first.report.recoveryTicks,
          mountMs: Math.max(first.mountMs, second.mountMs, realtime?.mountMs || 0),
          visualStates: Math.min(first.visualStates, second.visualStates),
        },
        vclockRuns: [
          { ...first.summary, mountMs: first.mountMs, visualStates: first.visualStates },
          { ...second.summary, mountMs: second.mountMs, visualStates: second.visualStates },
        ],
        realtimeSmoke: realtime ? {
          ...realtime.summary,
          mountMs: realtime.mountMs,
          timedOut: realtime.timedOut,
        } : null,
      };
    } finally {
      await browser.close();
    }
  });
}

async function readBoundedStdin(limit = LEVEL_GATE_STDIN_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error(`level gate request exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (!size) throw new Error('level gate request is required on stdin');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('level gate request must be valid JSON'); }
  return value;
}

function cleanError(error) {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 5000);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--identity') {
      const identity = await resolveGateIdentity();
      console.log(JSON.stringify({
        schema: 'sort.qa-execution.v1',
        gateVersion: identity.gateVersion,
        browserRuntimeDigest: identity.browserRuntimeDigest,
        platform: identity.platform,
        oracleVersion: identity.oracleVersion,
        policyDigest: identity.policyDigest,
      }));
      process.exitCode = 0;
    } else {
      const request = await readBoundedStdin();
      const result = await evaluateSortLevel(request, {
        onStatus(event) { console.log(`STATUS ${JSON.stringify(event)}`); },
      });
      console.log(`RESULT ${JSON.stringify(result)}`);
    }
  } catch (error) {
    console.error(`ERROR ${JSON.stringify({ error: cleanError(error), incidentId: randomUUID() })}`);
    process.exitCode = 1;
  }
}
