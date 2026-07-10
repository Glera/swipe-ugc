#!/usr/bin/env node
/**
 * Local-only T3 experiment worker.
 *
 * Claude Code may edit only marble-sort-swipe/src inside a detached worktree.
 * This process owns the trust boundary: it validates the diff, builds with the
 * known toolchain, and requires a complete headless autoplay WIN before exposing
 * an artifact under the ignored u/local-experiments directory.
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
const AGENT_TIMEOUT_MS = Math.max(60, Number(process.env.UGC_EXPERIMENT_AGENT_TIMEOUT_SEC || 600)) * 1000;
const TEST_TIMEOUT_MS = Math.max(30, Number(process.env.UGC_EXPERIMENT_TEST_TIMEOUT_SEC || 150)) * 1000;
const CLAUDE_MODEL = process.env.ISLAND_EXPERIMENT_MODEL || 'sonnet';
const CODEX_MODEL = String(process.env.CODEX_EXPERIMENT_MODEL || '').trim();
const EFFORT = new Set(['low', 'medium', 'high', 'xhigh']).has(process.env.ISLAND_EXPERIMENT_EFFORT || '')
  ? process.env.ISLAND_EXPERIMENT_EFFORT
  : 'medium';

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

function status(phase, message, attempt = 0) {
  console.log(`STATUS ${JSON.stringify({ phase, message, attempt })}`);
}

function fail(message) {
  throw new Error(String(message).replace(/\s+/g, ' ').trim().slice(0, 5000));
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.replaceEnv ? options.env : { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    const max = options.maxBuffer || 4 * 1024 * 1024;
    const append = (current, chunk) => (current + chunk.toString()).slice(-max);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, options.timeoutMs) : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
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

async function validateDiff(worktree) {
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

async function invokeAgent(worktree, attempt, failure) {
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
  const output = await run(command, commandArgs, {
    cwd: worktree,
    timeoutMs: AGENT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: subscriptionCliEnv(provider),
    replaceEnv: true,
  });
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

async function autoplay(worktree, attempt) {
  status('test', 'Autoplay is trying to beat the new rules', attempt);
  const dist = path.join(worktree, 'marble-sort-swipe', 'dist-swipe');
  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url || '/').split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\//, '');
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404; res.end(); return;
    }
    res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript');
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const errors = [];
  let lastState = null;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      window.__events = [];
      window.addEventListener('message', (event) => {
        if (event.data && typeof event.data === 'object' && event.data.source === 'playable') {
          window.__events.push({ type: String(event.data.type || ''), success: event.data.success });
        }
      });
    });
    await page.goto(`http://127.0.0.1:${port}/?auto=1`, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      lastState = await page.evaluate(() => ({
        canvas: Boolean(document.querySelector('canvas')),
        events: window.__events,
        debug: typeof window.__sortDebug === 'function' ? window.__sortDebug() : null,
      }));
      const won = lastState.events.some((event) => /complet|won|win/i.test(event.type) && event.success !== false);
      if (won) {
        if (errors.length) throw new Error(`AUTOPLAY ERRORS\n${errors.slice(0, 8).join('\n')}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await browser.close();
    server.close();
  }
  throw new Error(`AUTOPLAY FAILED after ${Math.round(TEST_TIMEOUT_MS / 1000)}s\nerrors=${JSON.stringify(errors.slice(0, 8))}\nstate=${JSON.stringify(lastState)}`);
}

async function publishLocal(worktree, patch, files, baseCommit, attempts, agentSummary) {
  const digest = createHash('sha1').update(baseCommit).update('\0').update(patch).digest('hex').slice(0, 10);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'wild-sort';
  const id = `${slug}-${digest}`;
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const dist = path.join(worktree, 'marble-sort-swipe', 'dist-swipe');
  let html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const payload = readFileSync(path.join(dist, 'payload.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const payloadTag = '<script type="module" src="./payload.js"></script>';
  if (!html.includes(payloadTag)) fail('experimental shell has no payload reference');
  // A single local HTML can run in an iframe sandbox without same-origin access
  // to the platform. It also keeps a lab result self-contained for tuning.
  html = html.replace(payloadTag, `<script type="module">${payload}</script>`);
  writeFileSync(path.join(artifactRoot, `${id}.html`), html);
  const extraFiles = readdirSync(dist).filter((file) => file !== 'index.html' && file !== 'payload.js');
  if (extraFiles.length) fail(`experimental build emitted unsupported external files: ${extraFiles.join(', ')}`);
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
  await runChecked('git', ['worktree', 'add', '--detach', worktree, baseCommit], { cwd: playablesRoot, timeoutMs: 60000 });
  const dependencies = path.join(playablesRoot, 'node_modules');
  if (!existsSync(dependencies)) fail('playables/node_modules is missing; run npm ci before starting the local lab');
  symlinkSync(dependencies, path.join(worktree, 'node_modules'), 'dir');
  if (parent) await runChecked('git', ['apply', '--whitespace=nowarn', parent.patchPath], { cwd: worktree });

  let lastFailure = '', agentSummary = '', validated = null, wonAt = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      agentSummary = await invokeAgent(worktree, attempt, lastFailure);
      status('safety', 'Checking the code sandbox and patch budget', attempt);
      validated = await validateDiff(worktree);
      if (parent && validated.patch === readFileSync(parent.patchPath, 'utf8')) {
        throw new Error('TUNING FAILED: Claude did not change the parent experiment');
      }
      await build(worktree, attempt);
      await autoplay(worktree, attempt);
      wonAt = attempt;
      break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      status('failed-attempt', lastFailure.slice(0, 360), attempt);
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
  if (!validated || !wonAt) fail('experiment exhausted its repair budget');
  status('publish', 'Autoplay won; saving the local experiment', wonAt);
  const result = await publishLocal(worktree, validated.patch, validated.files, baseCommit, wonAt, agentSummary);
  console.log(`RESULT ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`ERROR ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`);
  process.exitCode = 1;
} finally {
  if (worktree) {
    try { await run('git', ['worktree', 'remove', '--force', worktree], { cwd: playablesRoot, timeoutMs: 60000 }); } catch { /* best effort */ }
    rmSync(worktree, { recursive: true, force: true });
  }
}
