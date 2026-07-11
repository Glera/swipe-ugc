#!/usr/bin/env node
/**
 * Local-only T3 experiment worker.
 *
 * Claude Code or Codex may edit only marble-sort-swipe/src inside a disposable
 * clone pinned to an exact commit/tree. The release checkout and its refs are
 * never writable by the agent. This process validates the diff, type-checks new
 * diagnostics, builds with the known toolchain, injects a network-deny CSP, and
 * runs browser conformance. An unproven win may remain local, but publication
 * always repeats a strict autoplay WIN gate.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  assertHardenedExperimentHtml,
  hardenExperimentHtml,
  installExternalNetworkDeny,
} from './hardening.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspace = path.resolve(repoRoot, '..');
const playablesRoot = process.env.PLAYABLES_ROOT
  ? path.resolve(process.env.PLAYABLES_ROOT)
  : path.join(workspace, 'playables');
const localRoot = path.join(repoRoot, '.local-experiments');
const artifactRoot = path.join(repoRoot, 'u', 'local-experiments');
const baselineCatalog = JSON.parse(readFileSync(path.join(repoRoot, 'generator', 'baselines.json'), 'utf8'));
const MAX_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.UGC_EXPERIMENT_ATTEMPTS || 3)));
const AGENT_TIMEOUT_MS = Math.max(300, Number(process.env.UGC_EXPERIMENT_AGENT_TIMEOUT_SEC || 86400)) * 1000;
const TOTAL_TIMEOUT_MS = Math.max(3600, Number(process.env.UGC_EXPERIMENT_TOTAL_TIMEOUT_SEC || 86400)) * 1000;
const AGENT_SILENCE_WARN_MS = Math.max(1800, Number(process.env.UGC_EXPERIMENT_AGENT_SILENCE_WARN_SEC || 7200)) * 1000;
const AGENT_HEARTBEAT_MS = Math.max(60, Number(process.env.UGC_EXPERIMENT_HEARTBEAT_SEC || 300)) * 1000;
const TEST_TIMEOUT_MS = Math.max(30, Number(process.env.UGC_EXPERIMENT_TEST_TIMEOUT_SEC || 150)) * 1000;
const IDLE_TEST_MS = Math.max(5, Number(process.env.UGC_EXPERIMENT_IDLE_SEC || 30)) * 1000;
const MIN_WIN_MS = Math.max(2, Number(process.env.UGC_EXPERIMENT_MIN_WIN_SEC || 3)) * 1000;
const TEST_SEED = Number(process.env.UGC_EXPERIMENT_TEST_SEED || 0x5eed1234) >>> 0;
const CLAUDE_MODEL = process.env.ISLAND_EXPERIMENT_MODEL || 'sonnet';
const CODEX_MODEL = String(process.env.CODEX_EXPERIMENT_MODEL || '').trim();
const EFFORT = new Set(['low', 'medium', 'high', 'xhigh']).has(process.env.ISLAND_EXPERIMENT_EFFORT || '')
  ? process.env.ISLAND_EXPERIMENT_EFFORT
  : 'medium';
const experimentStartedAt = Date.now();

function subscriptionCliEnv(provider) {
  const env = { ...process.env };
  const keys = provider === 'codex'
    ? ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'CODEX_API_KEY']
    : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  for (const key of keys) delete env[key];
  return env;
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const prompt = String(args.prompt || '').trim().slice(0, 500);
const feedback = String(args.feedback || '').trim().slice(0, 500);
const parentId = String(args.parent || '').trim();
const provider = args.provider === 'codex' ? 'codex' : 'claude';
const baselineId = String(args.baseline || 'sort-v2').trim();
const baseline = baselineCatalog.baselines?.[baselineId];
if (!baseline || baseline.template !== 'sort' || baseline.releasePlayable !== false) {
  fail(`unknown or unsafe generator baseline: ${baselineId}`);
}
let concept;
try { concept = JSON.parse(String(args.concept || '{}')); } catch { concept = {}; }
const title = String(concept.title || 'Wild sort experiment').trim().slice(0, 60);
const pitch = String(concept.pitch || concept.summary || '').trim().slice(0, 500);
const mechanic = String(concept.mechanic || '').trim().slice(0, 500);
const feeling = String(concept.feeling || '').trim().slice(0, 240);

function status(phase, message, attempt = 0, details = {}) {
  console.log(`STATUS ${JSON.stringify({ phase, message, attempt, ...details })}`);
}

function fail(message) {
  throw new Error(String(message).replace(/\s+/g, ' ').trim().slice(0, 5000));
}

class AutoplayIncompleteError extends Error {}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.replaceEnv ? options.env : { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, abortReason = '';
    let lastActivityAt = Date.now();
    const max = options.maxBuffer || 4 * 1024 * 1024;
    const append = (current, chunk) => (current + chunk.toString()).slice(-max);
    child.stdout.on('data', (chunk) => { lastActivityAt = Date.now(); stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { lastActivityAt = Date.now(); stderr = append(stderr, chunk); });
    options.onSpawn?.({ pid: child.pid, startedAt: lastActivityAt });
    const heartbeat = options.onHeartbeat ? setInterval(() => {
      if (child.exitCode !== null) return;
      const reason = options.onHeartbeat({ pid: child.pid, lastActivityAt, startedAt: Date.now() - (options.elapsedMs?.() || 0) });
      if (typeof reason === 'string' && reason) {
        abortReason = reason;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }
    }, options.heartbeatMs || AGENT_HEARTBEAT_MS) : null;
    heartbeat?.unref();
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, options.timeoutMs) : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      resolve({ code: code ?? 1, stdout, stderr, timedOut, abortReason, lastActivityAt });
    });
  });
}

async function runChecked(command, commandArgs, options = {}) {
  const result = await run(command, commandArgs, options);
  if (result.timedOut) throw new Error(`${command} timed out`);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).slice(-7000));
  return result.stdout;
}

function loadParent() {
  if (!parentId) return null;
  if (!/^[a-z0-9-]{8,80}$/.test(parentId)) fail('invalid parent experiment id');
  const manifestPath = path.join(localRoot, `${parentId}.json`);
  const patchPath = path.join(localRoot, `${parentId}.patch`);
  if (!existsSync(manifestPath) || !existsSync(patchPath)) fail('parent experiment is unavailable on this dev machine');
  return {
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    patchPath,
  };
}

const FORBIDDEN = [
  [/\bfetch\s*\(/i, 'fetch'],
  [/\bXMLHttpRequest\b/i, 'XMLHttpRequest'],
  [/\bWebSocket\b/i, 'WebSocket'],
  [/\bEventSource\b/i, 'EventSource'],
  [/\bnavigator\.sendBeacon\b/i, 'sendBeacon'],
  [/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/i, 'persistent storage'],
  [/\beval\s*\(/i, 'eval'],
  [/\bnew\s+Function\b/i, 'new Function'],
  [/\bimport\s*\(/i, 'dynamic import'],
  [/\bwindow\.open\s*\(/i, 'window.open'],
  [/\blocation\s*=|\blocation\.(?:href|assign|replace)\s*[=(]/i, 'navigation'],
];

async function validateDiff(worktree, baseCommit) {
  const head = (await runChecked('git', ['rev-parse', 'HEAD'], { cwd: worktree })).trim();
  if (head !== baseCommit) fail('agent changed git history inside the disposable clone');
  const porcelain = await runChecked('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree });
  // Do not trim the whole porcelain stream: the leading space in " M path"
  // is the first status column, not whitespace.
  const entries = porcelain.split('\n').filter((line) => line.length >= 4).map((line) => ({
    code: line.slice(0, 2),
    file: line.slice(3).split(' -> ').pop(),
  })).filter((entry) => entry.file !== 'node_modules'); // trusted dependency symlink created above
  const allChanged = [...new Set(entries.map((entry) => entry.file))];
  if (!allChanged.length) fail('agent made no code changes');
  for (const file of allChanged) {
    if (!/^marble-sort-swipe\/src\/[A-Za-z0-9._/-]+\.ts$/.test(file) || file.includes('..')) {
      fail(`agent touched forbidden path: ${file}`);
    }
  }
  const untracked = entries.filter((entry) => entry.code === '??').map((entry) => entry.file);
  if (untracked.length) await runChecked('git', ['add', '-N', '--', ...untracked], { cwd: worktree });
  const rawStatus = await runChecked('git', ['diff', '--name-status', '--', 'marble-sort-swipe/src'], { cwd: worktree });
  if (/^D\s/m.test(rawStatus)) fail('agent deleted a source file');

  const patch = await runChecked('git', ['diff', '--binary', '--', 'marble-sort-swipe/src'], { cwd: worktree, maxBuffer: 1024 * 1024 });
  if (Buffer.byteLength(patch) > 350 * 1024) fail('experiment patch exceeds 350 KB');
  const numstat = await runChecked('git', ['diff', '--numstat', '--', 'marble-sort-swipe/src'], { cwd: worktree });
  const changedLines = numstat.trim().split('\n').filter(Boolean).reduce((sum, line) => {
    const [added, removed] = line.split('\t');
    return sum + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
  if (changedLines < 20) fail(`experiment is too small (${changedLines} changed lines); make a material rules/render/autoplay variation`);

  for (const file of allChanged) {
    const source = readFileSync(path.join(worktree, file), 'utf8');
    for (const [pattern, label] of FORBIDDEN) if (pattern.test(source)) fail(`${file} uses forbidden capability: ${label}`);
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier === 'matter-js' || specifier === '../../shared' || specifier === '../playable.config') continue;
      if (specifier.startsWith('./')) {
        const resolved = path.resolve(path.dirname(path.join(worktree, file)), specifier);
        const srcRoot = path.join(worktree, 'marble-sort-swipe', 'src') + path.sep;
        if (resolved.startsWith(srcRoot)) continue;
      }
      fail(`${file} imports forbidden dependency: ${specifier}`);
    }
  }
  return { patch, files: allChanged };
}

function agentPrompt(attempt, failure) {
  const repair = failure
    ? `\nThe previous implementation failed the external gate. Diagnose and EDIT the code to fix it. Gate output:\n${failure.slice(-6000)}\n`
    : '';
  const lineage = parentId
    ? `This is a tuning pass over experiment ${parentId}. Player feedback: ${feedback || 'make the concept more distinctive without losing playability'}.`
    : 'This is the first implementation of the selected concept.';
  const toolBoundary = provider === 'claude'
    ? 'You have scoped Read/Edit only.'
    : 'You are inside a disposable workspace-write sandbox. The outer worker rejects every path outside marble-sort-swipe/src and runs build/autoplay itself.';
  return `You are implementing a deliberately surprising SWIPE-only variation of an existing marble-sort playable.

Read marble-sort-swipe/src/main.ts and related files before editing. Then materially change the playable so it creates a different feeling through rules, interaction, physics, pacing, layout, or rendering. Do the implementation now; do not merely describe it.

Player brief: ${prompt || 'surprise me'}
Selected concept: ${title}
Feeling: ${feeling}
Pitch: ${pitch}
Mechanic direction: ${mechanic}
${lineage}

Hard executable contract:
- Edit ONLY TypeScript files under marble-sort-swipe/src/. This is the SWIPE mechanic; do not touch FTUE, AppLovin, shared, scripts, config, or other playables.
- Preserve bootstrap/lifecycle and the playable postMessage contract.
- ?auto=1 must autonomously understand your new rules, play the variant, and emit a successful completed event. Update its autoplay strategy when rules change.
- Manual play must remain possible and the canvas must remain responsive at 390px mobile width.
- No network, navigation, storage, eval, dynamic imports, new packages, or external assets.
- Keep runtime light enough for a mid-range Android. Avoid shadowBlur and unbounded particle/body creation.
- Strange is welcome. Broken is not. Do not reduce the experiment to a palette-only retheme.
- The resulting lineage patch must change at least 20 source lines; a few constants or colors are not an experiment.

The outer worker, not you, runs build and Playwright. ${toolBoundary} Finish by briefly naming what changed.${repair}`;
}

function latestSourceMtime(worktree) {
  const root = path.join(worktree, 'marble-sort-swipe', 'src');
  const pending = [root];
  let latest = 0;
  while (pending.length) {
    const current = pending.pop();
    let names;
    try { names = readdirSync(current); } catch { continue; }
    for (const name of names) {
      const file = path.join(current, name);
      let stat;
      try { stat = statSync(file); } catch { continue; }
      if (stat.isDirectory()) pending.push(file);
      else if (name.endsWith('.ts')) latest = Math.max(latest, stat.mtimeMs);
    }
  }
  return latest;
}

async function invokeAgent(worktree, attempt, failure, timeboxMs) {
  const label = provider === 'codex' ? 'Codex' : 'Claude';
  status(attempt === 1 ? 'agent' : 'repair', attempt === 1 ? `${label} studies the pinned baseline and mutates the fork` : `${label} repairs the failed experiment`, attempt);
  const command = provider === 'codex' ? 'codex' : 'claude';
  const commandArgs = provider === 'codex'
    ? [
        '--sandbox', 'workspace-write',
        '--ask-for-approval', 'never',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-C', worktree,
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        ...(CODEX_MODEL ? ['--model', CODEX_MODEL] : []),
        agentPrompt(attempt, failure),
      ]
    : [
        '--no-session-persistence',
        '--disable-slash-commands',
        '--permission-mode', 'default',
        '--tools', 'Read,Edit',
        '--allowedTools', 'Read(./marble-sort-swipe/**),Read(./shared/**),Edit(./marble-sort-swipe/src/**)',
        '--model', CLAUDE_MODEL,
        '--effort', EFFORT,
        '-p', agentPrompt(attempt, failure),
      ];
  const passStartedAt = Date.now();
  let observedSourceMtime = latestSourceMtime(worktree);
  let lastEditAt = passStartedAt;
  const output = await run(command, commandArgs, {
    cwd: worktree,
    timeoutMs: timeboxMs,
    maxBuffer: 1024 * 1024,
    env: subscriptionCliEnv(provider),
    replaceEnv: true,
    elapsedMs: () => Date.now() - passStartedAt,
    onSpawn: ({ pid }) => {
      const now = new Date().toISOString();
      status('agent-started', `${label} PID ${pid} is running`, attempt, {
        liveness: 'agent',
        agentPid: pid,
        checkedAt: now,
        lastSignalAt: now,
        sourceEdited: false,
      });
    },
    onHeartbeat: ({ pid, lastActivityAt }) => {
      const sourceMtime = latestSourceMtime(worktree);
      if (sourceMtime > observedSourceMtime) {
        observedSourceMtime = sourceMtime;
        lastEditAt = Date.now();
      }
      const lastSignalAt = Math.max(lastActivityAt, lastEditAt);
      const quietMs = Date.now() - lastSignalAt;
      const elapsedMin = Math.max(1, Math.round((Date.now() - passStartedAt) / 60000));
      const editState = lastEditAt > passStartedAt ? 'source edits detected' : 'no source edit yet';
      const quiet = quietMs >= AGENT_SILENCE_WARN_MS;
      const silence = quiet ? ' · QUIET, but PID is alive; continuing' : '';
      status('agent-heartbeat', `${label} PID ${pid} alive · ${editState} · ${elapsedMin}m elapsed · last signal ${Math.round(quietMs / 60000)}m ago${silence}`, attempt, {
        liveness: quiet ? 'quiet' : 'agent',
        agentPid: pid,
        checkedAt: new Date().toISOString(),
        lastSignalAt: new Date(lastSignalAt).toISOString(),
        sourceEdited: lastEditAt > passStartedAt,
      });
      return '';
    },
  });
  status('agent-finished', `${label} process exited; inspecting its patch`, attempt, {
    liveness: 'runner',
    checkedAt: new Date().toISOString(),
  });
  if (output.abortReason) throw new Error(`AGENT STALLED: ${output.abortReason}`);
  if (output.timedOut) {
    status('agent-timeout', 'Coding timebox reached; testing the current patch', attempt);
    return output.stdout.trim().slice(-2000);
  }
  if (output.code !== 0) throw new Error((output.stderr || output.stdout || `${label} agent failed`).slice(-7000));
  return output.stdout.trim().slice(-2000);
}

async function build(worktree, attempt) {
  status('build', 'Building the mutated SWIPE fork', attempt);
  const result = await run('bash', ['scripts/build-swipe.sh', 'marble-sort-swipe'], {
    cwd: worktree,
    timeoutMs: 180000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.timedOut) throw new Error('BUILD FAILED: build timed out');
  if (result.code !== 0) throw new Error(`BUILD FAILED\n${(result.stderr || result.stdout).slice(-7000)}`);
  const payload = path.join(worktree, 'marble-sort-swipe', 'dist-swipe', 'payload.js');
  if (!existsSync(payload)) throw new Error('BUILD FAILED: payload.js is missing');
  if (statSync(payload).size > 700 * 1024) throw new Error(`BUILD FAILED: payload is ${statSync(payload).size} bytes (limit 716800)`);
}

const normalizeDiagnostic = (line) => line.replace(/\(\d+,\d+\)/, '(line)');

async function collectTypeDiagnostics(worktree) {
  const tsc = path.join(worktree, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('TYPECHECK FAILED: local TypeScript compiler is missing');
  const result = await run(tsc, ['--noEmit', '--pretty', 'false'], {
    cwd: worktree,
    timeoutMs: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.timedOut) throw new Error('TYPECHECK FAILED: tsc timed out');
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => /\.ts\(\d+,\d+\): error TS\d+:/.test(line));
}

async function typecheck(worktree, changedFiles, baselineDiagnostics, attempt) {
  status('typecheck', 'Checking new TypeScript diagnostics in the mutated files', attempt);
  const diagnostics = await collectTypeDiagnostics(worktree);
  const changed = diagnostics.filter((line) => changedFiles.some((file) => line.startsWith(`${file}(`)));
  const added = changed.filter((line) => !baselineDiagnostics.has(normalizeDiagnostic(line)));
  if (added.length) throw new Error(`TYPECHECK FAILED\n${added.slice(0, 20).join('\n')}`);
}

function selfContainedArtifact(worktree) {
  const dist = path.join(worktree, 'marble-sort-swipe', 'dist-swipe');
  const extraFiles = readdirSync(dist).filter((file) => file !== 'index.html' && file !== 'payload.js');
  if (extraFiles.length) fail(`experimental build emitted unsupported external files: ${extraFiles.join(', ')}`);
  let html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const payload = readFileSync(path.join(dist, 'payload.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const payloadTag = '<script type="module" src="./payload.js"></script>';
  if (!html.includes(payloadTag)) fail('experimental shell has no payload reference');
  html = html.replace(payloadTag, `<script type="module">${payload}</script>`);
  html = hardenExperimentHtml(html);
  assertHardenedExperimentHtml(html);
  return html;
}

async function withArtifactServer(html, runGate) {
  const server = createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname !== '/' && pathname !== '/index.html') { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await runGate(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function configureGatePage(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errors = [];
  const externalAttempts = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await installExternalNetworkDeny(page, origin, externalAttempts);
  await page.addInitScript((seed) => {
    let randomState = Number(seed) >>> 0;
    Math.random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x100000000;
    };
    window.__gate = { events: [], violations: [], rafFrames: 0 };
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => nativeRaf((time) => {
      window.__gate.rafFrames++;
      callback(time);
    });
    window.addEventListener('message', (event) => {
      if (event.data && typeof event.data === 'object' && event.data.source === 'playable') {
        window.__gate.events.push(event.data);
      }
    });
    window.addEventListener('securitypolicyviolation', (event) => {
      window.__gate.violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  }, TEST_SEED);
  return { page, errors, externalAttempts };
}

async function conformance(html, attempt) {
  status('conformance', 'Checking lifecycle, pause, manual input, idle stability, and network isolation', attempt);
  return withArtifactServer(html, async (origin) => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const { page, errors, externalAttempts } = await configureGatePage(browser, origin);
      await page.goto(`${origin}/?auto=0&hostPaused=1&warmpaint=off&seed=${TEST_SEED}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('canvas', { timeout: 25000 });
      await page.waitForFunction(() => window.__gate.events.some((event) => event.type === 'static_ready'), undefined, { timeout: 25000 });
      const earlyInteractive = await page.evaluate(() => window.__gate.events.some((event) => event.type === 'interactive_ready'));
      if (earlyInteractive) throw new Error('CONFORMANCE FAILED: interactive_ready fired before prepareInteractive');
      await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'prepareInteractive' }, '*'));
      await page.waitForFunction(() => window.__gate.events.some((event) => event.type === 'interactive_ready'), undefined, { timeout: 10000 });
      await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: false }, '*'));
      await page.waitForFunction(() => window.__playable?.isPaused?.() === false, undefined, { timeout: 5000 });

      const canvas = page.locator('canvas');
      const box = await canvas.boundingBox();
      if (!box || box.width < 100 || box.height < 100) throw new Error('CONFORMANCE FAILED: canvas is not visibly sized');
      await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.24 } });
      await page.waitForTimeout(IDLE_TEST_MS);
      const activeState = await page.evaluate(() => window.__gate);
      if (activeState.rafFrames < 10) throw new Error(`CONFORMANCE FAILED: render loop produced only ${activeState.rafFrames} frames`);

      await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: true }, '*'));
      await page.waitForFunction(() => window.__playable?.isPaused?.() === true, undefined, { timeout: 5000 });
      await page.waitForTimeout(350);
      const pausedA = createHash('sha1').update(await canvas.screenshot()).digest('hex');
      await page.waitForTimeout(900);
      const pausedB = createHash('sha1').update(await canvas.screenshot()).digest('hex');
      if (pausedA !== pausedB) throw new Error('CONFORMANCE FAILED: canvas changed while host-paused');
      await page.evaluate(() => window.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: false }, '*'));

      const state = await page.evaluate(() => window.__gate);
      const staticIndex = state.events.findIndex((event) => event.type === 'static_ready');
      const interactiveIndex = state.events.findIndex((event) => event.type === 'interactive_ready');
      if (staticIndex < 0 || interactiveIndex <= staticIndex) throw new Error('CONFORMANCE FAILED: invalid static_ready → interactive_ready order');
      if (externalAttempts.length) throw new Error(`NETWORK DENY: ${externalAttempts.slice(0, 8).join(', ')}`);
      if (state.violations.length) throw new Error(`CSP VIOLATION: ${state.violations.slice(0, 8).join(', ')}`);
      if (errors.length) throw new Error(`CONFORMANCE ERRORS\n${errors.slice(0, 8).join('\n')}`);
      return { idleMs: IDLE_TEST_MS, rafFrames: state.rafFrames };
    } finally {
      await browser.close();
    }
  });
}

async function autoplay(html, attempt, runNumber) {
  status(runNumber === 1 ? 'test' : 'test-retry', `Autoplay run ${runNumber} is trying to beat the new rules with fixed seed ${TEST_SEED}`, attempt);
  return withArtifactServer(html, async (origin) => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    let lastState = null;
    try {
      const { page, errors, externalAttempts } = await configureGatePage(browser, origin);
      const startedAt = Date.now();
      const visualStates = new Set();
      let lastCaptureAt = 0;
      await page.goto(`${origin}/?auto=1&seed=${TEST_SEED}`, { waitUntil: 'domcontentloaded' });
      const deadline = Date.now() + TEST_TIMEOUT_MS;
      while (Date.now() < deadline) {
        lastState = await page.evaluate(() => ({
          canvas: Boolean(document.querySelector('canvas')),
          events: window.__gate.events,
          violations: window.__gate.violations,
          rafFrames: window.__gate.rafFrames,
          debug: typeof window.__sortDebug === 'function' ? window.__sortDebug() : null,
        }));
        if (lastState.canvas && Date.now() - lastCaptureAt >= 1500) {
          const shot = await page.locator('canvas').screenshot();
          visualStates.add(createHash('sha1').update(shot).digest('hex'));
          lastCaptureAt = Date.now();
        }
        const completed = lastState.events.find((event) => /complet|won|win/i.test(String(event.type || '')));
        if (completed) {
          const durationMs = Date.now() - startedAt;
          if (completed.success !== true) throw new Error(`AUTOPLAY CONTRACT FAILED: completed.success must be true, got ${JSON.stringify(completed.success)}`);
          if (durationMs < MIN_WIN_MS) throw new Error(`AUTOPLAY DEGENERATE: win arrived in ${durationMs}ms (minimum ${MIN_WIN_MS}ms)`);
          if (visualStates.size < 2) throw new Error('AUTOPLAY DEGENERATE: canvas did not visibly change before the win');
          const fps = lastState.rafFrames / Math.max(1, durationMs / 1000);
          if (fps < 5) throw new Error(`AUTOPLAY PERFORMANCE FAILED: observed rAF rate ${fps.toFixed(1)}fps`);
          if (externalAttempts.length) throw new Error(`NETWORK DENY: ${externalAttempts.slice(0, 8).join(', ')}`);
          if (lastState.violations.length) throw new Error(`CSP VIOLATION: ${lastState.violations.slice(0, 8).join(', ')}`);
          if (errors.length) throw new Error(`AUTOPLAY ERRORS\n${errors.slice(0, 8).join('\n')}`);
          return { durationMs, rafFrames: lastState.rafFrames, visualStates: visualStates.size, runNumber };
        }
        if (lastState.events.some((event) => /complet|lost|lose/i.test(String(event.type || '')) && event.success === false)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (externalAttempts.length) throw new Error(`NETWORK DENY: ${externalAttempts.slice(0, 8).join(', ')}`);
      if (lastState?.violations?.length) throw new Error(`CSP VIOLATION: ${lastState.violations.slice(0, 8).join(', ')}`);
      if (!lastState?.canvas) throw new Error(`RUNTIME FAILED: no canvas\nstate=${JSON.stringify(lastState)}`);
      if (errors.length) throw new Error(`RUNTIME FAILED during autoplay\nerrors=${JSON.stringify(errors.slice(0, 8))}\nstate=${JSON.stringify(lastState)}`);
      throw new AutoplayIncompleteError(`Autoplay run ${runNumber} did not prove a win within ${Math.round(TEST_TIMEOUT_MS / 1000)}s`);
    } finally {
      await browser.close();
    }
  });
}

async function autoplayWithFlakeRetry(html, attempt, onRun) {
  try {
    onRun();
    return { result: await autoplay(html, attempt, 1), runs: 1 };
  } catch (error) {
    if (!(error instanceof AutoplayIncompleteError)) throw error;
    status('test-retry', 'Autoplay was inconclusive; rerunning the same fixed build before spending another agent attempt', attempt);
    onRun();
    return { result: await autoplay(html, attempt, 2), runs: 2 };
  }
}

async function publishLocal(patch, files, baseCommit, attempts, agentSummary, autoplayPassed, gateError, html, metrics) {
  const digest = createHash('sha1').update(baseCommit).update('\0').update(patch).digest('hex').slice(0, 10);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'wild-sort';
  const id = `${slug}-${digest}`;
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  assertHardenedExperimentHtml(html);
  writeFileSync(path.join(artifactRoot, `${id}.html`), html);
  writeFileSync(path.join(localRoot, `${id}.patch`), patch);
  const manifest = {
    id,
    parentId: parentId || null,
    baselineId,
    baselineTree: baseline.sourceTree,
    provider,
    baseCommit,
    title,
    pitch,
    mechanic,
    feeling,
    prompt,
    feedback: feedback || null,
    attempts,
    autoplayPassed,
    gateError,
    wallTimeMs: Date.now() - experimentStartedAt,
    agentTimeoutSec: Math.round(AGENT_TIMEOUT_MS / 1000),
    agentSilenceWarnSec: Math.round(AGENT_SILENCE_WARN_MS / 1000),
    totalTimeoutSec: Math.round(TOTAL_TIMEOUT_MS / 1000),
    agentInvocations: metrics.agentInvocations,
    playtestRuns: metrics.playtestRuns,
    conformance: metrics.conformance,
    autoplay: metrics.autoplay,
    model: provider === 'codex' ? (CODEX_MODEL || 'subscription-default') : CLAUDE_MODEL,
    effort: provider === 'codex' ? (CODEX_MODEL ? 'model-configured' : 'subscription-default') : EFFORT,
    testSeed: TEST_SEED,
    files,
    agentSummary,
    createdAt: new Date().toISOString(),
    url: `/ugc/u/local-experiments/${id}.html`,
  };
  writeFileSync(path.join(localRoot, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

let worktree = '';
try {
  if (!existsSync(path.join(playablesRoot, '.git'))) fail(`playables repo not found: ${playablesRoot}`);
  const parent = loadParent();
  const baseCommit = String(baseline.sourceCommit);
  const actualCommit = (await runChecked('git', ['rev-parse', `${baseCommit}^{commit}`], { cwd: playablesRoot })).trim();
  const actualTree = (await runChecked('git', ['rev-parse', `${baseCommit}:${baseline.sourcePath}`], { cwd: playablesRoot })).trim();
  if (actualCommit !== baseCommit || actualTree !== baseline.sourceTree) {
    fail(`generator baseline ${baselineId} failed its immutable commit/tree lock`);
  }
  if (parent) {
    const parentBaseline = parent.manifest.baselineId || (parent.manifest.baseCommit === baseCommit ? baselineId : '');
    if (parentBaseline !== baselineId) fail('parent experiment belongs to a different generator baseline');
  }
  worktree = mkdtempSync(path.join(tmpdir(), 'swipe-wild-sort-'));
  rmSync(worktree, { recursive: true, force: true });
  status('fork', parent ? 'Restoring the parent experiment in an isolated fork' : 'Creating an isolated mechanic fork');
  await runChecked('git', ['clone', '--shared', '--no-checkout', playablesRoot, worktree], { cwd: workspace, timeoutMs: 60000 });
  await runChecked('git', ['checkout', '--detach', baseCommit], { cwd: worktree, timeoutMs: 60000 });
  const cloneHead = (await runChecked('git', ['rev-parse', 'HEAD'], { cwd: worktree })).trim();
  if (cloneHead !== baseCommit) fail('disposable clone did not resolve the pinned baseline commit');
  const dependencies = path.join(playablesRoot, 'node_modules');
  if (!existsSync(dependencies)) fail('playables/node_modules is missing; run npm ci before starting the local lab');
  symlinkSync(dependencies, path.join(worktree, 'node_modules'), 'dir');
  if (parent) await runChecked('git', ['apply', '--whitespace=nowarn', parent.patchPath], { cwd: worktree });
  status('typecheck-baseline', 'Recording pre-existing diagnostics so only new errors consume the experiment budget');
  const baselineDiagnostics = new Set((await collectTypeDiagnostics(worktree)).map(normalizeDiagnostic));

  let lastFailure = '', agentSummary = '', validated = null, artifactHtml = '', wonAt = 0;
  let autoplayPassed = true, gateError = null;
  let agentInvocations = 0, playtestRuns = 0, conformanceMetrics = null, autoplayMetrics = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const remainingMs = experimentStartedAt + TOTAL_TIMEOUT_MS - Date.now();
      if (remainingMs < 300000) throw new Error('EXPERIMENT DEADLINE: the 24-hour job budget is exhausted');
      agentInvocations++;
      agentSummary = await invokeAgent(worktree, attempt, lastFailure, Math.min(AGENT_TIMEOUT_MS, remainingMs));
      status('safety', 'Checking the code sandbox and patch budget', attempt);
      validated = await validateDiff(worktree, baseCommit);
      if (parent && validated.patch === readFileSync(parent.patchPath, 'utf8')) {
        throw new Error('TUNING FAILED: Claude did not change the parent experiment');
      }
      await typecheck(worktree, validated.files, baselineDiagnostics, attempt);
      await build(worktree, attempt);
      artifactHtml = selfContainedArtifact(worktree);
      conformanceMetrics = await conformance(artifactHtml, attempt);
      const playtest = await autoplayWithFlakeRetry(artifactHtml, attempt, () => { playtestRuns++; });
      autoplayMetrics = playtest.result;
      wonAt = attempt;
      break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (error instanceof AutoplayIncompleteError && validated) {
        autoplayPassed = false;
        gateError = lastFailure;
        wonAt = attempt;
        status('soft-gate', 'Build is healthy, but autoplay could not prove a win; keeping the local experiment', attempt);
        break;
      }
      status('failed-attempt', lastFailure.slice(0, 360), attempt);
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
  if (!validated || !artifactHtml || !wonAt) fail('experiment exhausted its repair budget');
  status('publish', autoplayPassed ? 'Autoplay won; saving the local experiment' : 'Saving the unverified local experiment', wonAt);
  const result = await publishLocal(
    validated.patch,
    validated.files,
    baseCommit,
    wonAt,
    agentSummary,
    autoplayPassed,
    gateError,
    artifactHtml,
    { agentInvocations, playtestRuns, conformance: conformanceMetrics, autoplay: autoplayMetrics },
  );
  console.log(`RESULT ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`ERROR ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`);
  process.exitCode = 1;
} finally {
  if (worktree) rmSync(worktree, { recursive: true, force: true });
}
