import assert from 'node:assert/strict';
import test from 'node:test';

import { modelInvocationArgs, normaliseModelInvocation } from '../worker/model-invocation.mjs';

test('code worker forwards exact model and effort to both subscription CLIs', () => {
  assert.deepEqual(modelInvocationArgs({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' }), [
    '-c', 'model_reasoning_effort="ultra"', '--model', 'gpt-5.6-sol',
  ]);
  assert.deepEqual(modelInvocationArgs({ provider: 'claude', model: 'opus', effort: 'max' }), [
    '--model', 'opus', '--effort', 'max',
  ]);
});

test('code worker never silently substitutes malformed effort or model', () => {
  assert.throws(() => normaliseModelInvocation({ provider: 'codex', model: 'sol', effort: 'MAX!' }),
    /refusing silent substitution/);
  assert.throws(() => normaliseModelInvocation({ provider: 'claude', model: 'bad model', effort: 'medium' }),
    /invalid subscription model id/);
  assert.equal(normaliseModelInvocation({ provider: 'claude', model: 'sonnet', effort: '' }).effort, 'medium',
    'legacy jobs without an effort retain the documented default');
});
