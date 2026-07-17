#!/usr/bin/env node
/**
 * Local-only T3 experiment worker.
 *
 * Claude Code or Codex may edit only marble-sort-swipe/src inside a disposable
 * clone pinned to an exact commit/tree. The release checkout and its refs are
 * never writable by the agent. This process validates the diff, type-checks new
 * diagnostics, builds with the known toolchain, injects a network-deny CSP, and
 * runs browser conformance. Incomplete or unproven evidence is a typed,
 * non-zero failure; publication repeats the strict autoplay WIN gate.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  lstatSync,
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
import { modelInvocationArgs, normaliseModelInvocation } from './model-invocation.mjs';
import {
  assertCompleteEvidence,
  buildWorkerFailure,
  sanitiseModelEvidence,
} from './result-contract.mjs';
import {
  loadParentClosure,
  loadWorkerInputEnvelope,
  publishExperimentResult,
} from './publish-local.mjs';
import {
  assertGitMetadataUnchanged,
  assertTrustedDependencyLink,
  captureGitMetadata,
  captureTrustedDependencyTarget,
  hiddenIndexFlags,
  indexFlagClearCommands,
} from './worktree-integrity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspace = path.resolve(repoRoot, '..');
const playablesRoot = process.env.PLAYABLES_ROOT
  ? path.resolve(process.env.PLAYABLES_ROOT)
  : path.join(workspace, 'playables');
const localRoot = path.join(repoRoot, '.local-experiments');
const artifactRoot = path.join(repoRoot, 'u', 'local-experiments');
const baselineCatalog = JSON.parse(readFileSync(path.join(repoRoot, 'generator', 'baselines.json'), 'utf8'));
const AGENT_TIMEOUT_MS = Math.max(300, Number(process.env.UGC_EXPERIMENT_AGENT_TIMEOUT_SEC || 86400)) * 1000;
const TOTAL_TIMEOUT_MS = Math.max(3600, Number(process.env.UGC_EXPERIMENT_TOTAL_TIMEOUT_SEC || 86400)) * 1000;
const AGENT_SILENCE_WARN_MS = Math.max(1800, Number(process.env.UGC_EXPERIMENT_AGENT_SILENCE_WARN_SEC || 7200)) * 1000;
const AGENT_HEARTBEAT_MS = Math.max(60, Number(process.env.UGC_EXPERIMENT_HEARTBEAT_SEC || 300)) * 1000;
const TEST_TIMEOUT_MS = Math.max(30, Number(process.env.UGC_EXPERIMENT_TEST_TIMEOUT_SEC || 150)) * 1000;
const IDLE_TEST_MS = Math.max(5, Number(process.env.UGC_EXPERIMENT_IDLE_SEC || 30)) * 1000;
const MIN_WIN_MS = Math.max(2, Number(process.env.UGC_EXPERIMENT_MIN_WIN_SEC || 3)) * 1000;
let TEST_SEED = 0;
const experimentStartedAt = Date.now();

const SUBSCRIPTION_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME',
];

function subscriptionCliEnv(provider) {
  if (!['claude', 'codex'].includes(provider)) fail('unknown subscription provider');
  const env = {};
  for (const key of SUBSCRIPTION_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const inputEnvelopePath = String(args['input-envelope'] || '');
const expectedInputDigest = String(args['input-digest'] || '');
let workerInput = null;
let prompt = '';
let parentId = '';
let provider = '';
let selectedModel = '';
let baselineId = '';
let baseline = null;
let feedback = '';
let invocation = null;
let EFFORT = '';
let title = '';
let pitch = '';
let mechanic = '';
let feeling = '';

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
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, abortReason = '';
    let lastActivityAt = Date.now();
    const max = options.maxBuffer || 4 * 1024 * 1024;
    const append = (current, chunk) => (current + chunk.toString()).slice(-max);
    child.stdout.on('data', (chunk) => { lastActivityAt = Date.now(); stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { lastActivityAt = Date.now(); stderr = append(stderr, chunk); });
    if (options.input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(String(options.input));
    }
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
  return options.includeStderr ? `${result.stdout}\n${result.stderr}` : result.stdout;
}

function trustedGitEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    ...overrides,
  };
}

async function runTrustedGit(commandArgs, options = {}) {
  const { env: envOverrides, ...rest } = options;
  return runChecked('git', [
    '--no-replace-objects',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'diff.external=',
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.excludesFile=/dev/null',
    ...commandArgs,
  ], {
    ...rest,
    env: trustedGitEnv(envOverrides),
    replaceEnv: true,
  });
}

async function clearIndexFlags(worktree, files) {
  for (const command of indexFlagClearCommands(files)) await runTrustedGit(command, { cwd: worktree });
}

async function normalizeIndexFlags(worktree) {
  const tracked = (await runTrustedGit(['ls-files', '-z'], { cwd: worktree })).split('\0').filter(Boolean);
  await clearIndexFlags(worktree, tracked);
  const hidden = hiddenIndexFlags(await runTrustedGit(['ls-files', '-v', '-z'], { cwd: worktree }));
  if (hidden.length) fail(`unable to clear hidden git index flags: ${hidden[0].file}`);
}

async function assertWorktreeIntegrity(worktree, integrity) {
  assertGitMetadataUnchanged(worktree, integrity.git, { excludeIndex: true });
  assertTrustedDependencyLink(worktree, integrity.dependencies);
  const hidden = hiddenIndexFlags(await runTrustedGit(['ls-files', '-v', '-z'], { cwd: worktree }));
  if (hidden.length) {
    await clearIndexFlags(worktree, hidden.map(({ file }) => file));
    fail(`agent set assume-unchanged/skip-worktree on ${hidden[0].file}; flags were cleared and the attempt was rejected`);
  }
  assertGitMetadataUnchanged(worktree, integrity.git);
}

async function assertSubscriptionAuth() {
  if (provider === 'claude') {
    const raw = await runChecked('claude', ['auth', 'status', '--json'], {
      cwd: repoRoot,
      timeoutMs: 15000,
      maxBuffer: 100000,
      env: subscriptionCliEnv('claude'),
      replaceEnv: true,
    });
    let auth;
    try { auth = JSON.parse(raw.trim()); } catch { fail('Claude subscription auth status is unreadable'); }
    if (auth.loggedIn !== true || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty') {
      fail('Claude is not authenticated through a first-party claude.ai subscription; refusing provider fallback');
    }
    return;
  }
  const raw = await runChecked('codex', ['login', 'status'], {
    cwd: repoRoot,
    timeoutMs: 15000,
    maxBuffer: 100000,
    env: subscriptionCliEnv('codex'),
    replaceEnv: true,
    includeStderr: true,
  });
  if (!/Logged in using ChatGPT/i.test(raw)) {
    fail('Codex is not authenticated through ChatGPT; refusing provider fallback');
  }
}

const FORBIDDEN = [
  [/\bfetch\s*\(/i, 'fetch'],
  [/\bXMLHttpRequest\b/i, 'XMLHttpRequest'],
  [/\bWebSocket\b/i, 'WebSocket'],
  [/\bEventSource\b/i, 'EventSource'],
  [/\bnavigator\.sendBeacon\b/i, 'sendBeacon'],
  [/\bnavigator\.serviceWorker\b/i, 'service worker'],
  [/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/i, 'persistent storage'],
  [/\beval\s*\(/i, 'eval'],
  [/\bnew\s+Function\b/i, 'new Function'],
  [/\bimport\s*\(/i, 'dynamic import'],
  [/\bwindow\.open\s*\(/i, 'window.open'],
  [/\blocation\s*=|\blocation\.(?:href|assign|replace)\s*[=(]/i, 'navigation'],
];

async function validateDiff(worktree, baseCommit, integrity) {
  await assertWorktreeIntegrity(worktree, integrity);
  const head = (await runTrustedGit(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
  if (head !== baseCommit) fail('agent changed git history inside the disposable clone');
  const porcelain = await runTrustedGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree });
  // Do not trim the whole porcelain stream: the leading space in " M path"
  // is the first status column, not whitespace.
  const entries = porcelain.split('\n').filter((line) => line.length >= 4).map((line) => ({
    code: line.slice(0, 2),
    file: line.slice(3).split(' -> ').pop(),
  })).filter((entry) => entry.file !== 'node_modules');
  const allChanged = [...new Set(entries.map((entry) => entry.file))].sort();
  if (!allChanged.length) fail('agent made no code changes');
  for (const file of allChanged) {
    if (!/^marble-sort-swipe\/src\/[A-Za-z0-9._/-]+\.ts$/.test(file) || file.includes('..')) {
      fail(`agent touched forbidden path: ${file}`);
    }
  }
  const ignored = await runTrustedGit([
    'status', '--ignored=matching', '--porcelain=v1', '--untracked-files=all',
  ], { cwd: worktree });
  const forbiddenIgnored = ignored.split('\n')
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3).split(' -> ').pop())
    .filter((file) => file !== 'node_modules' && !file.startsWith('node_modules/'));
  if (forbiddenIgnored.length) fail(`agent created an ignored file outside the reviewable patch: ${forbiddenIgnored[0]}`);

  const untracked = entries.filter((entry) => entry.code === '??').map((entry) => entry.file);
  const scratch = mkdtempSync(path.join(tmpdir(), 'swipe-diff-index-'));
  let rawStatus;
  let patch;
  let numstat;
  try {
    const diffIndex = path.join(scratch, 'index');
    const env = { GIT_INDEX_FILE: diffIndex };
    await runTrustedGit(['read-tree', baseCommit], { cwd: worktree, env });
    if (untracked.length) await runTrustedGit(['add', '-N', '--', ...untracked], { cwd: worktree, env });
    rawStatus = await runTrustedGit([
      'diff', '--no-ext-diff', '--ita-invisible-in-index', '--name-status', '--', 'marble-sort-swipe/src',
    ], { cwd: worktree, env });
    patch = await runTrustedGit([
      'diff', '--no-ext-diff', '--ita-invisible-in-index', '--binary', '--', 'marble-sort-swipe/src',
    ], { cwd: worktree, env, maxBuffer: 1024 * 1024 });
    numstat = await runTrustedGit([
      'diff', '--no-ext-diff', '--ita-invisible-in-index', '--numstat', '--', 'marble-sort-swipe/src',
    ], { cwd: worktree, env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (/^D\s/m.test(rawStatus)) fail('agent deleted a source file');
  if (Buffer.byteLength(patch) > 350 * 1024) fail('experiment patch exceeds 350 KB');
  const changedLines = numstat.trim().split('\n').filter(Boolean).reduce((sum, line) => {
    const [added, removed] = line.split('\t');
    return sum + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
  if (changedLines < 20) fail(`experiment is too small (${changedLines} changed lines); make a material rules/render/autoplay variation`);

  for (const file of allChanged) {
    const sourcePath = path.join(worktree, file);
    const sourceStat = lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!sourceStat?.isFile()) fail(`agent source must be a regular file: ${file}`);
    const source = readFileSync(sourcePath, 'utf8');
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
  await assertWorktreeIntegrity(worktree, integrity);
  return { patch, files: allChanged };
}

function agentPrompt() {
  // One job carries exactly one physical model invocation: there is no
  // internal repair round, so there is no failure transcript to embed.
  const lineage = `This is a tuning pass over experiment ${parentId}. Player feedback: ${feedback}.`;
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

The outer worker, not you, runs build and Playwright. ${toolBoundary} Finish by briefly naming what changed.`;
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

async function invokeAgent(worktree, timeboxMs) {
  const label = provider === 'codex' ? 'Codex' : 'Claude';
  const attempt = 1; // exactly one physical model invocation per job
  status('agent', `${label} studies the pinned baseline and mutates the fork`, attempt);
  const command = provider === 'codex' ? 'codex' : 'claude';
  const promptText = agentPrompt();
  const commandArgs = provider === 'codex'
    ? [
        ...modelInvocationArgs(invocation),
        '--sandbox', 'workspace-write',
        '--ask-for-approval', 'never',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-C', worktree,
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '-',
      ]
    : [
        '--no-session-persistence',
        '--disable-slash-commands',
        '--setting-sources', '',
        '--permission-mode', 'dontAsk',
        '--tools', 'Read,Edit',
        '--allowedTools', 'Read(./marble-sort-swipe/**),Read(./shared/**),Edit(./marble-sort-swipe/src/**)',
        ...modelInvocationArgs(invocation),
        '-p',
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
    input: promptText,
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

async function build(worktree, attempt, integrity) {
  await assertWorktreeIntegrity(worktree, integrity);
  status('build', 'Building the mutated SWIPE fork', attempt);
  const result = await run('bash', ['scripts/build-swipe.sh', 'marble-sort-swipe'], {
    cwd: worktree,
    timeoutMs: 180000,
    maxBuffer: 2 * 1024 * 1024,
    env: trustedGitEnv(),
    replaceEnv: true,
  });
  if (result.timedOut) throw new Error('BUILD FAILED: build timed out');
  if (result.code !== 0) throw new Error(`BUILD FAILED\n${(result.stderr || result.stdout).slice(-7000)}`);
  const payload = path.join(worktree, 'marble-sort-swipe', 'dist-swipe', 'payload.js');
  if (!existsSync(payload)) throw new Error('BUILD FAILED: payload.js is missing');
  if (statSync(payload).size > 700 * 1024) throw new Error(`BUILD FAILED: payload is ${statSync(payload).size} bytes (limit 716800)`);
  await assertWorktreeIntegrity(worktree, integrity);
}

const normalizeDiagnostic = (line) => line.replace(/\(\d+,\d+\)/, '(line)');

async function collectTypeDiagnostics(worktree, integrity = null) {
  if (integrity) await assertWorktreeIntegrity(worktree, integrity);
  const tsc = path.join(worktree, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('TYPECHECK FAILED: local TypeScript compiler is missing');
  const result = await run(tsc, ['--noEmit', '--pretty', 'false'], {
    cwd: worktree,
    timeoutMs: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.timedOut) throw new Error('TYPECHECK FAILED: tsc timed out');
  if (integrity) await assertWorktreeIntegrity(worktree, integrity);
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => /\.ts\(\d+,\d+\): error TS\d+:/.test(line));
}

async function typecheck(worktree, changedFiles, baselineDiagnostics, attempt, integrity) {
  status('typecheck', 'Checking new TypeScript diagnostics in the mutated files', attempt);
  const diagnostics = await collectTypeDiagnostics(worktree, integrity);
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
      status('cover', 'Capturing a real gameplay frame for the candidate card', attempt);
      const coverAspect = 16 / 9;
      const coverHeight = Math.min(box.height, box.width / coverAspect);
      const coverWidth = Math.min(box.width, coverHeight * coverAspect);
      const coverPng = await page.screenshot({
        type: 'png',
        clip: {
          x: box.x + (box.width - coverWidth) / 2,
          y: box.y + (box.height - coverHeight) / 2,
          width: coverWidth,
          height: coverHeight,
        },
      });

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
      return { metrics: { idleMs: IDLE_TEST_MS, rafFrames: state.rafFrames }, coverPng };
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

function publishCandidate({ patch, files, agentSummary, html, coverPng, metrics }) {
  assertHardenedExperimentHtml(html);
  return publishExperimentResult({
    localRoot,
    artifactRoot,
    input: workerInput,
    html,
    coverPng,
    patch,
    fields: {
      title,
      concept: {
        prompt,
        pitch,
        mechanic,
        feeling,
      },
      autoplayPassed: true,
      wallTimeMs: Date.now() - experimentStartedAt,
      agentInvocations: metrics.agentInvocations,
      playtestRuns: metrics.playtestRuns,
      conformance: metrics.conformance,
      autoplay: metrics.autoplay,
      files,
      agentSummary,
      createdAt: new Date().toISOString(),
      coverBytes: coverPng.length,
    },
  });
}

let worktree = '';
try {
  const allowedArgs = new Set(['input-digest', 'input-envelope']);
  const foreignArg = Object.keys(args).find((key) => !allowedArgs.has(key));
  if (foreignArg) {
    const error = new Error(`parallel CLI authority is forbidden: --${foreignArg}`);
    error.code = 'experiment_worker_input_invalid';
    throw error;
  }
  workerInput = loadWorkerInputEnvelope({ inputPath: inputEnvelopePath, expectedInputDigest });
  prompt = 'Implement the exact reviewed tuning goal.';
  parentId = workerInput.parent.targetId;
  provider = workerInput.model.provider;
  selectedModel = workerInput.model.argument;
  baselineId = workerInput.baseline.id;
  baseline = baselineCatalog.baselines?.[baselineId];
  feedback = workerInput.request.instruction;
  TEST_SEED = workerInput.worker.testSeed;
  invocation = normaliseModelInvocation({
    provider,
    model: selectedModel,
    effort: workerInput.model.effort,
  });
  EFFORT = invocation.effort;
  if (!baseline || baseline.template !== 'sort' || baseline.releasePlayable !== false) {
    fail(`unknown or unsafe generator baseline: ${baselineId}`);
  }
  if (!existsSync(path.join(playablesRoot, '.git'))) fail(`playables repo not found: ${playablesRoot}`);
  // Parent closure is captured exactly once with hardened no-follow reads:
  // manifest is a verified typed result, patch/html/cover bytes replay its
  // artifact identity, and only the captured patch bytes are ever applied.
  const parent = loadParentClosure({
    localRoot,
    artifactRoot,
    expectedArtifact: workerInput.parent.evidence.parentArtifact,
  });
  title = String(parent.manifest.title || 'Reworked sort experiment');
  pitch = String(parent.manifest.concept?.pitch || 'Apply the reviewed tuning without changing lineage.');
  mechanic = String(parent.manifest.concept?.mechanic || 'Preserve the parent rule and improve its legibility.');
  feeling = String(parent.manifest.concept?.feeling || 'A clearer version of the reviewed payoff.');
  const baseCommit = workerInput.baseline.sourceCommit;
  const actualCommit = (await runTrustedGit(['rev-parse', `${baseCommit}^{commit}`], { cwd: playablesRoot })).trim();
  const actualTree = (await runTrustedGit(['rev-parse', `${baseCommit}:${baseline.sourcePath}`], { cwd: playablesRoot })).trim();
  if (baseline.sourceCommit !== workerInput.baseline.sourceCommit
    || baseline.sourceTree !== workerInput.baseline.sourceTree
    || actualCommit !== baseCommit || actualTree !== workerInput.baseline.sourceTree) {
    fail(`generator baseline ${baselineId} failed its immutable commit/tree lock`);
  }
  worktree = mkdtempSync(path.join(tmpdir(), 'swipe-wild-sort-'));
  rmSync(worktree, { recursive: true, force: true });
  status('fork', 'Restoring the exact reviewed parent experiment in an isolated fork');
  await runTrustedGit(['clone', '--shared', '--no-checkout', playablesRoot, worktree], { cwd: workspace, timeoutMs: 60000 });
  await runTrustedGit(['checkout', '--detach', baseCommit], { cwd: worktree, timeoutMs: 60000 });
  const cloneHead = (await runTrustedGit(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
  if (cloneHead !== baseCommit) fail('disposable clone did not resolve the pinned baseline commit');
  const dependencies = path.join(playablesRoot, 'node_modules');
  if (!existsSync(dependencies)) fail('playables/node_modules is missing; run npm ci before starting the local lab');
  symlinkSync(dependencies, path.join(worktree, 'node_modules'), 'dir');
  const trustedDependencies = captureTrustedDependencyTarget(dependencies);
  assertTrustedDependencyLink(worktree, trustedDependencies);
  // Apply ONLY the captured closure bytes from a path this process owns —
  // the parent pathname is never re-opened after verification.
  const capturedPatch = path.join(worktree, '.parent-closure.patch');
  writeFileSync(capturedPatch, parent.patchBytes);
  await runTrustedGit(['apply', '--whitespace=nowarn', capturedPatch], { cwd: worktree });
  rmSync(capturedPatch, { force: true });
  await normalizeIndexFlags(worktree);
  const integrity = { git: captureGitMetadata(worktree), dependencies: trustedDependencies };
  status('typecheck-baseline', 'Recording pre-existing diagnostics so only new errors consume the experiment budget');
  const baselineDiagnostics = new Set((await collectTypeDiagnostics(worktree, integrity)).map(normalizeDiagnostic));

  // Exact worker contract: one physical model invocation, then one honest
  // gate pass. There is no internal repair loop and no soft success — an
  // unproven autoplay win or incomplete evidence is a typed non-zero exit,
  // and the repair/rework cycle belongs to the generator's job layer.
  let playtestRuns = 0;
  const remainingMs = experimentStartedAt + TOTAL_TIMEOUT_MS - Date.now();
  if (remainingMs < 300000) throw new Error('EXPERIMENT DEADLINE: the 24-hour job budget is exhausted');
  status('auth', `Verifying ${provider} subscription login`);
  await assertSubscriptionAuth();
  const agentSummary = await invokeAgent(worktree, Math.min(AGENT_TIMEOUT_MS, remainingMs));
  status('safety', 'Checking the code sandbox and patch budget', 1);
  const validated = await validateDiff(worktree, baseCommit, integrity);
  if (validated.patch === parent.patchBytes.toString('utf8')) {
    const unchanged = new Error('TUNING FAILED: the agent did not change the parent experiment');
    unchanged.code = 'tuning_unchanged';
    throw unchanged;
  }
  await typecheck(worktree, validated.files, baselineDiagnostics, 1, integrity);
  await build(worktree, 1, integrity);
  const artifactHtml = selfContainedArtifact(worktree);
  const conformanceResult = await conformance(artifactHtml, 1);
  let autoplayMetrics;
  try {
    const playtest = await autoplayWithFlakeRetry(artifactHtml, 1, () => { playtestRuns++; });
    autoplayMetrics = playtest.result;
  } catch (error) {
    if (error instanceof AutoplayIncompleteError) {
      error.code = 'autoplay_unproven';
    }
    throw error;
  }
  assertCompleteEvidence({
    validated,
    artifactHtml,
    coverPng: conformanceResult.coverPng,
    autoplayPassed: true,
    conformanceMetrics: conformanceResult.metrics,
    autoplayMetrics,
  });
  await assertWorktreeIntegrity(worktree, integrity);
  status('publish', 'Autoplay won; saving the local experiment', 1);
  const published = publishCandidate({
    patch: validated.patch,
    files: validated.files,
    agentSummary,
    html: artifactHtml,
    coverPng: conformanceResult.coverPng,
    metrics: {
      agentInvocations: 1,
      playtestRuns,
      conformance: conformanceResult.metrics,
      autoplay: autoplayMetrics,
    },
  });
  if (published.replayed) {
    status('publish-replayed', 'Identical immutable candidate already committed; replaying its exact bytes', 1);
  }
  console.log(`RESULT ${JSON.stringify(published.result)}`);
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'worker_failed';
  const message = error instanceof Error ? error.message : String(error);
  const failure = workerInput
    ? buildWorkerFailure({ input: workerInput, code, message })
    : {
        code: 'experiment_worker_input_invalid',
        message: sanitiseModelEvidence(message, 2000),
      };
  console.log(`ERROR ${JSON.stringify(failure)}`);
  process.exitCode = 1;
} finally {
  if (worktree) rmSync(worktree, { recursive: true, force: true });
}
