#!/usr/bin/env node
/**
 * UGC bake worker: recipe → baked fork → autoplay smoke test → git publish → Telegram notify.
 *
 * Dev-machine rehearsal of the production pipeline. Invoked automatically by
 * the feed dev server after a successful theme generation (feed-prototype/
 * vite.config.ts → islandThemeApi), or manually:
 *
 *   node worker/bake.mjs --pack '<theme-pack json>' [--prompt '...'] [--user dev] [--tpl sort] [--chat <telegram chat id>]
 *
 * --chat is the PLAYER's chat id (from the mini-app initData) — each player is
 * notified personally. UGC_NOTIFY_CHAT_ID env is only a dev-machine fallback
 * for testing outside Telegram.
 *
 * Env: PLAYABLES_ROOT=/path/to/playables, UGC_FULL_WIN=1 (gate on full autoplay win), UGC_NO_PUSH=1,
 *      BOT_TOKEN (+ optional UGC_NOTIFY_CHAT_ID fallback), UGC_BASE_URL (link in message).
 *
 * On success prints a machine-readable line: RESULT {"rel":"u/<user>/<id>.html"}
 *
 * Exit code 0 = published (or committed with push skipped); non-zero = failed,
 * nothing committed, artifacts removed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { createServer } from 'http';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspace = path.resolve(repoRoot, '..');
const playablesRoot = process.env.PLAYABLES_ROOT
  ? path.resolve(process.env.PLAYABLES_ROOT)
  : path.join(workspace, 'playables');

// Same recipe constants as the client fork (feed-prototype/src/island.ts).
const SORT_MARBLES = ['#F5C842', '#5BC8D8', '#FF9F43', '#FF7B7B', '#B07BFF', '#7BE87B'];
const BASE_BUILDS = { sort: 'marble-sort-swipe' };
const HEX = /^#[0-9A-Fa-f]{6}$/;
const PROPS = new Set(['mushroom', 'crystal', 'coral', 'lollipop', 'rock']);

function validatePack(p) {
  if (!p || typeof p !== 'object') return 'pack must be an object';
  if (!Array.isArray(p.items) || p.items.length !== 6 || !p.items.every((c) => typeof c === 'string' && HEX.test(c)))
    return 'pack.items must be exactly 6 #RRGGBB colors';
  for (const key of ['ground', 'edge', 'boardBg', 'body', 'roof']) {
    if (typeof p[key] !== 'string' || !HEX.test(p[key])) return `pack.${key} must be a #RRGGBB color`;
  }
  if (typeof p.name !== 'string' || !p.name.trim()) return 'pack.name must be a non-empty string';
  if (typeof p.prop !== 'string' || !PROPS.has(p.prop)) return 'pack.prop is invalid';
  return null;
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const log = (m) => console.log(`[bake] ${m}`);
const written = [];
const fail = (m) => {
  for (const f of written) { try { rmSync(f); } catch { /* noop */ } }
  console.error(`[bake] FAIL: ${m}`);
  process.exit(1);
};

const tpl = args.tpl ?? 'sort';
const user = (args.user ?? 'dev').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'dev';
if (!BASE_BUILDS[tpl]) fail(`no bake recipe for template "${tpl}" yet`);
let pack;
try { pack = JSON.parse(args.pack); } catch { fail('--pack must be valid JSON'); }
const packError = validatePack(pack);
if (packError) fail(packError);

// ── 1. bake ──────────────────────────────────────────────────────────────────
const distDir = path.join(playablesRoot, BASE_BUILDS[tpl], 'dist-swipe');
let html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
let payload = readFileSync(path.join(distDir, 'payload.js'), 'utf8');
if (!payload.includes(SORT_MARBLES[0])) fail('stale recipe: palette constants not found in base payload');
let replaced = 0;
SORT_MARBLES.forEach((hex, i) => {
  replaced += payload.split(hex).length - 1;
  payload = payload.split(hex).join(pack.items[i % pack.items.length]);
});
const hash = createHash('sha1').update(payload).digest('hex').slice(0, 8);
// Latin-only slug: cyrillic and other scripts would end up percent-encoded in
// URLs and can break CDNs; the display name stays as-is in the notification.
const slug = String(args.prompt || pack.name || 'mech').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mech';
const id = `${slug}-${hash}`;
if (!html.includes('src="./payload.js"')) fail('base html has no ./payload.js reference');
html = html.replace('src="./payload.js"', `src="./${id}.payload.js"`);
const outDir = path.join(repoRoot, 'u', user);
mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `${id}.html`);
const payloadPath = path.join(outDir, `${id}.payload.js`);
if (existsSync(htmlPath)) {
  log(`already published: u/${user}/${id}.html — nothing to do`);
  console.log(`RESULT ${JSON.stringify({ rel: `u/${user}/${id}.html` })}`);
  process.exit(0);
}
writeFileSync(htmlPath, html);
written.push(htmlPath);
writeFileSync(payloadPath, payload);
written.push(payloadPath);
log(`baked u/${user}/${id} (${replaced} palette replacements, payload ${payload.length}b)`);

// ── 2. test (headless autoplay) ──────────────────────────────────────────────
const FULL_WIN = process.env.UGC_FULL_WIN === '1';
const server = createServer((req, res) => {
  const p = path.join(repoRoot, decodeURIComponent((req.url || '/').split('?')[0]));
  if (!p.startsWith(repoRoot) || !existsSync(p) || !statSync(p).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await import('playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // The playable posts to window.parent — top-level, parent === window, so the
  // same window receives its own messages.
  await page.addInitScript(() => {
    window.__events = [];
    window.addEventListener('message', (e) => {
      if (e.data && typeof e.data === 'object' && e.data.source === 'playable') {
        window.__events.push({ type: String(e.data.type ?? ''), success: e.data.success });
      }
    });
  });
  await page.goto(`http://127.0.0.1:${port}/u/${user}/${id}.html?auto=1`, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + (FULL_WIN ? 180000 : 25000);
  let booted = false, won = false, bootedAt = 0;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      ev: window.__events,
      canvas: !!document.querySelector('canvas'),
    }));
    if (!booted && (st.canvas || st.ev.some((e) => /ready|loaded/i.test(e.type)))) { booted = true; bootedAt = Date.now(); }
    won = st.ev.some((e) => /complet|won|win/i.test(e.type) && e.success !== false);
    if (won) break;
    if (!FULL_WIN && booted && Date.now() - bootedAt > 8000) break;   // boot + grace period
    await new Promise((r) => setTimeout(r, 500));
  }
  if (errors.length) fail(`console/page errors during test:\n  ${errors.slice(0, 5).join('\n  ')}`);
  if (FULL_WIN && !won) fail('autoplay did not reach a win within 180s');
  if (!booted) fail('fork did not boot (no canvas, no ready event) within 25s');
  log(FULL_WIN ? `test passed: autoplay WIN, no errors` : `test passed: booted, ${won ? 'won during grace, ' : ''}8s error-free`);
} finally {
  await browser.close();
  server.close();
}

// ── 3. publish ───────────────────────────────────────────────────────────────
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
git('add', htmlPath, payloadPath);
git('commit', '-m', `bake: u/${user}/${id} — "${pack.name ?? slug}" (${tpl})\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`);
log(`committed ${git('rev-parse', '--short', 'HEAD')}`);
let pushed = false;
if (process.env.UGC_NO_PUSH === '1') log('push skipped (UGC_NO_PUSH=1)');
else if (!git('remote')) log('push skipped (no git remote configured)');
else { git('push'); pushed = true; log('pushed'); }

// ── 4. notify ────────────────────────────────────────────────────────────────
const relUrl = `u/${user}/${id}.html`;
const url = process.env.UGC_BASE_URL ? `${process.env.UGC_BASE_URL.replace(/\/$/, '')}/${relUrl}` : relUrl;
const text = `🌱 Механика «${pack.name ?? slug}» готова!\n✅ Сгенерирована, протестирована автоплеем и опубликована.\n${url}`;
// Per-player notification: --chat comes from the player's Telegram initData;
// the env var is only a dev fallback for testing outside Telegram.
const chatId = args.chat || process.env.UGC_NOTIFY_CHAT_ID;
if (process.env.BOT_TOKEN && chatId) {
  const resp = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await resp.json();
  if (!j.ok) console.error(`[bake] notify failed: ${JSON.stringify(j)}`);
  else log(`notified chat ${chatId}`);
} else {
  log(`notify skipped (${process.env.BOT_TOKEN ? 'no chat id (player outside Telegram, no dev fallback)' : 'no BOT_TOKEN'}); would send:\n${text.split('\n').map((l) => '  | ' + l).join('\n')}`);
}
console.log(`RESULT ${JSON.stringify({ rel: relUrl })}`);
log(`DONE ${relUrl}${pushed ? ' (pushed)' : ''}`);
