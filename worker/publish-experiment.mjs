#!/usr/bin/env node
/**
 * Publish one successful local experiment without touching the playable source.
 *
 * The input is an ignored, self-contained HTML artifact produced by
 * experiment.mjs. This worker retests it in a sandbox, creates a detached
 * swipe-ugc worktree from origin, commits only HTML + public metadata, pushes,
 * and optionally waits for the immutable Render URL to become live.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertHardenedExperimentHtml, installExternalNetworkDeny } from './hardening.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const localRoot = path.join(repoRoot, '.local-experiments');
const artifactRoot = path.join(repoRoot, 'u', 'local-experiments');
const branch = process.env.UGC_REPO_BRANCH || 'master';
const baseUrl = String(process.env.UGC_BASE_URL || '').replace(/\/$/, '');
const dryRun = process.env.UGC_PUBLISH_DRY_RUN === '1';
const commitDryRun = process.env.UGC_PUBLISH_COMMIT_DRY_RUN === '1';
const testTimeoutMs = Math.max(30, Number(process.env.UGC_EXPERIMENT_TEST_TIMEOUT_SEC || 150)) * 1000;
const minWinMs = Math.max(2, Number(process.env.UGC_EXPERIMENT_MIN_WIN_SEC || 3)) * 1000;
const testSeed = Number(process.env.UGC_EXPERIMENT_TEST_SEED || 0x5eed1234) >>> 0;
const deployWaitMs = Math.max(0, Number(process.env.UGC_DEPLOY_WAIT_SEC || 90)) * 1000;
const deployPollMs = Math.max(500, Number(process.env.UGC_DEPLOY_POLL_SEC || 3) * 1000);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const id = String(args.id || '').trim();
const user = String(args.user || 'dev').replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 64) || 'dev';
const chatId = String(args.chat || process.env.UGC_NOTIFY_CHAT_ID || '').trim();
if (!/^[a-z0-9-]{8,80}$/.test(id)) throw new Error('invalid local experiment id');
if (!dryRun && !commitDryRun && !baseUrl) throw new Error('UGC_BASE_URL is required before publishing');

function status(phase, message) {
  console.log(`STATUS ${JSON.stringify({ phase, message })}`);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
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

async function checked(command, commandArgs, options = {}) {
  const result = await run(command, commandArgs, options);
  if (result.timedOut) throw new Error(`${command} timed out`);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).slice(-7000));
  return result.stdout;
}

async function git(args, options = {}) {
  return checked('git', args, { cwd: options.cwd || repoRoot, timeoutMs: options.timeoutMs || 120000 });
}

async function gitExists(ref) {
  const result = await run('git', ['cat-file', '-e', ref], { cwd: repoRoot, timeoutMs: 30000 });
  return result.code === 0;
}

async function autoplay(html) {
  status('test', 'Rechecking the selected artifact in a sandbox');
  const wrapper = `<!doctype html><html><body><script>
window.__events=[];
window.addEventListener('message',event=>{if(event.data&&event.data.source==='playable')window.__events.push(event.data)});
</script><iframe sandbox="allow-scripts" src="/artifact.html?auto=1&seed=${testSeed}" style="border:0;width:390px;height:700px"></iframe></body></html>`;
  const server = createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/test.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(wrapper);
      return;
    }
    if (pathname === '/artifact.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const errors = [];
  const externalAttempts = [];
  let lastEvents = [];
  let runNumber = 1;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await installExternalNetworkDeny(page, `http://127.0.0.1:${port}`, externalAttempts);
    await page.addInitScript((seed) => {
      let state = Number(seed) >>> 0;
      Math.random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
      };
    }, testSeed);
    await page.goto(`http://127.0.0.1:${port}/test.html`, { waitUntil: 'domcontentloaded' });
    let runStartedAt = Date.now();
    const deadline = Date.now() + testTimeoutMs;
    while (Date.now() < deadline) {
      lastEvents = await page.evaluate(() => window.__events || []);
      const completion = lastEvents.find((event) => /complet|won|win/i.test(String(event?.type || '')));
      if (completion) {
        if (completion.success !== true) throw new Error(`sandbox completed event has invalid success=${JSON.stringify(completion.success)}`);
        if (Date.now() - runStartedAt < minWinMs) throw new Error(`sandbox won too early (${Date.now() - runStartedAt}ms)`);
        if (externalAttempts.length) throw new Error(`sandbox attempted external network access: ${externalAttempts.slice(0, 8).join(', ')}`);
        if (errors.length) throw new Error(`sandbox emitted errors: ${errors.slice(0, 8).join('\n')}`);
        return;
      }
      const lost = lastEvents.some((event) => /complet|lost|lose/i.test(String(event?.type || '')) && event?.success === false);
      if (lost && runNumber < 3) {
        runNumber++;
        status('test-retry', `Autoplay lost; starting clean run ${runNumber} of 3`);
        lastEvents = [];
        await page.goto(`http://127.0.0.1:${port}/test.html?run=${runNumber}`, { waitUntil: 'domcontentloaded' });
        runStartedAt = Date.now();
        continue;
      }
      if (lost) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  if (externalAttempts.length) throw new Error(`sandbox attempted external network access: ${externalAttempts.slice(0, 8).join(', ')}`);
  throw new Error(`sandbox autoplay did not win within ${Math.round(testTimeoutMs / 1000)}s; events=${JSON.stringify(lastEvents.slice(-12))}`);
}

async function waitForHosted(url, expectedHash, commit) {
  if (!url || !deployWaitMs) return false;
  status('deploy', 'Commit pushed; waiting for Render to serve the new artifact');
  const deadline = Date.now() + deployWaitMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${url}?commit=${encodeURIComponent(commit)}`, {
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.text();
        const hash = createHash('sha1').update(body).digest('hex');
        if (hash === expectedHash) return true;
      }
    } catch { /* deployment is still warming */ }
    finally { clearTimeout(timer); }
    await new Promise((resolve) => setTimeout(resolve, deployPollMs));
  }
  return false;
}

async function notify(title, url, ready) {
  if (!process.env.BOT_TOKEN || !chatId) return;
  const state = ready ? 'опубликована и уже доступна' : 'опубликована; Render еще разворачивает файл';
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `Экспериментальная механика «${title}» ${state}.\n${url}` }),
  });
  if (!response.ok) console.error(`STATUS ${JSON.stringify({ phase: 'notify-warning', message: `Telegram notification failed: HTTP ${response.status}` })}`);
}

const artifactPath = path.join(artifactRoot, `${id}.html`);
const manifestPath = path.join(localRoot, `${id}.json`);
if (!existsSync(artifactPath) || !existsSync(manifestPath)) throw new Error('local experiment artifact is unavailable');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.id !== id) throw new Error('local experiment manifest id mismatch');
const html = readFileSync(artifactPath, 'utf8');
assertHardenedExperimentHtml(html);
if (statSync(artifactPath).size > 1024 * 1024) throw new Error('experiment HTML exceeds the 1 MB publish limit');
if (/<script\b[^>]*\bsrc\s*=/i.test(html)) throw new Error('experiment is not self-contained: external script reference found');
const htmlHash = createHash('sha1').update(html).digest('hex');
const version = htmlHash.slice(0, 12);
const relHtml = `u/${user}/${id}.html`;
const relMeta = `u/${user}/${id}.meta.json`;
const url = baseUrl ? `${baseUrl}/${relHtml}` : '';

let worktree = '';
try {
  await autoplay(html);
  if (dryRun) {
    status('dry-run', 'Sandbox passed; publication stopped before git commit');
    console.log(`RESULT ${JSON.stringify({ id, rel: relHtml, meta: relMeta, url, commit: '', ready: false, dryRun: true })}`);
    process.exitCode = 0;
  } else {
    const remotes = (await git(['remote'])).trim();
    if (!remotes.split(/\s+/).includes('origin')) throw new Error('swipe-ugc origin remote is required');
    status('fetch', `Refreshing origin/${branch}`);
    await git(['fetch', '--depth', '20', 'origin', branch]);

    const remoteHtmlRef = `origin/${branch}:${relHtml}`;
    const remoteMetaRef = `origin/${branch}:${relMeta}`;
    const hasRemoteHtml = await gitExists(remoteHtmlRef);
    const hasRemoteMeta = await gitExists(remoteMetaRef);
    let commit = '';
    if (hasRemoteHtml || hasRemoteMeta) {
      if (!hasRemoteHtml || !hasRemoteMeta) throw new Error('remote experiment is incomplete; refusing to overwrite it');
      const remoteBlob = (await git(['rev-parse', remoteHtmlRef])).trim();
      const localBlob = (await git(['hash-object', artifactPath])).trim();
      if (remoteBlob !== localBlob) throw new Error('remote experiment id collision; refusing to overwrite it');
      commit = (await git(['log', '-1', '--format=%H', `origin/${branch}`, '--', relHtml])).trim();
      status('already-published', 'The exact artifact is already present in swipe-ugc');
    } else {
      worktree = mkdtempSync(path.join(tmpdir(), 'swipe-ugc-publish-'));
      rmSync(worktree, { recursive: true, force: true });
      await git(['worktree', 'add', '--detach', worktree, `origin/${branch}`]);
      const targetHtml = path.join(worktree, relHtml);
      const targetMeta = path.join(worktree, relMeta);
      mkdirSync(path.dirname(targetHtml), { recursive: true });
      copyFileSync(artifactPath, targetHtml);
      writeFileSync(targetMeta, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'free-experiment',
        artifact: relHtml,
        template: 'sort',
        experimentId: id,
        parentId: manifest.parentId || null,
        baseCommit: manifest.baseCommit,
        title: manifest.title,
        version,
        htmlBytes: Buffer.byteLength(html),
        payloadBytes: 0,
        inlinePayloadBytes: Buffer.byteLength(html),
        assetBytes: 0,
        assets: [],
        mediaBytes: 0,
        mountCost: 'medium',
        autoplayPassed: true,
        attempts: manifest.attempts,
      }, null, 2)}\n`);

      const porcelain = (await git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree }))
        .split('\n').filter(Boolean).map((line) => line.slice(3));
      const expected = [relHtml, relMeta].sort();
      if (JSON.stringify([...porcelain].sort()) !== JSON.stringify(expected)) {
        throw new Error(`publish worktree contains unexpected paths: ${porcelain.join(', ')}`);
      }
      status('commit', 'Committing only the standalone HTML and its metadata');
      await git(['add', '--', relHtml, relMeta], { cwd: worktree });
      await git(['commit', '-m', `publish experiment: ${relHtml}`], { cwd: worktree });
      const changed = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: worktree }))
        .trim().split('\n').filter(Boolean).sort();
      if (JSON.stringify(changed) !== JSON.stringify(expected)) {
        throw new Error(`commit allowlist failed: ${changed.join(', ')}`);
      }
      commit = (await git(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
      if (!commitDryRun) {
        status('push', `Pushing ${commit.slice(0, 8)} to swipe-ugc`);
        let push = await run('git', ['push', 'origin', `HEAD:${branch}`], { cwd: worktree, timeoutMs: 120000 });
        if (push.code !== 0) {
          await git(['pull', '--rebase', 'origin', branch], { cwd: worktree });
          commit = (await git(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
          status('push-retry', `Remote advanced; retrying rebased commit ${commit.slice(0, 8)}`);
          push = await run('git', ['push', 'origin', `HEAD:${branch}`], { cwd: worktree, timeoutMs: 120000 });
        }
        if (push.code !== 0) throw new Error((push.stderr || push.stdout || 'git push failed').slice(-7000));
        commit = (await git(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
        await git(['fetch', '--depth', '20', 'origin', branch]);
        const remoteBlob = (await git(['rev-parse', `origin/${branch}:${relHtml}`])).trim();
        const localBlob = (await git(['hash-object', artifactPath])).trim();
        if (remoteBlob !== localBlob || !await gitExists(`origin/${branch}:${relMeta}`)) {
          throw new Error('push returned but the exact artifact was not verified in origin');
        }
      }
    }

    if (commitDryRun) {
      status('commit-dry-run', 'Commit allowlist passed; temporary commit was not pushed');
      console.log(`RESULT ${JSON.stringify({ id, rel: relHtml, meta: relMeta, url, commit, ready: false, dryRun: true })}`);
    } else {
      const ready = await waitForHosted(url, htmlHash, commit);
      await notify(String(manifest.title || id), url, ready);
      console.log(`RESULT ${JSON.stringify({ id, rel: relHtml, meta: relMeta, url, commit, ready, dryRun: false })}`);
    }
  }
} catch (error) {
  console.error(`ERROR ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`);
  process.exitCode = 1;
} finally {
  if (worktree) {
    await run('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot, timeoutMs: 60000 });
    rmSync(worktree, { recursive: true, force: true });
  }
}
