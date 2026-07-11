import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHardenedExperimentHtml,
  hardenExperimentHtml,
} from '../worker/hardening.mjs';

test('experiment hardening injects network-deny CSP before playable scripts', () => {
  const hardened = hardenExperimentHtml('<!doctype html><html><head><script>window.booted=true</script></head><body></body></html>');
  assert.match(hardened, /connect-src 'none'/);
  assert.ok(hardened.indexOf('Content-Security-Policy') < hardened.indexOf('<script>'));
  assert.doesNotThrow(() => assertHardenedExperimentHtml(hardened));
});

test('publish guard rejects an artifact without enforced CSP', () => {
  assert.throws(() => assertHardenedExperimentHtml('<html><head></head></html>'), /network-deny CSP/);
});

test('guided hardening permits its same-origin payload but denies connections', () => {
  const hardened = hardenExperimentHtml(
    '<!doctype html><html><head><script type="module" src="./payload.js"></script></head><body></body></html>',
    { allowSameOriginScripts: true },
  );
  assert.match(hardened, /script-src 'self' 'unsafe-inline' blob:/);
  assert.match(hardened, /connect-src 'none'/);
});
