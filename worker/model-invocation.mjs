const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const EFFORT_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export function normaliseModelInvocation({ provider, model, effort }, { defaultEffort = 'medium' } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('unknown subscription provider');
  const modelArgument = String(model || '').trim();
  if (!MODEL_ID.test(modelArgument)) throw new Error('invalid subscription model id');
  const effortArgument = String(effort || defaultEffort).trim();
  if (!EFFORT_ID.test(effortArgument)) throw new Error('invalid model effort; refusing silent substitution');
  return Object.freeze({ provider, model: modelArgument, effort: effortArgument });
}

export function modelInvocationArgs(invocation) {
  const value = normaliseModelInvocation(invocation);
  return value.provider === 'codex'
    ? ['-c', `model_reasoning_effort="${value.effort}"`, '--model', value.model]
    : ['--model', value.model, '--effort', value.effort];
}
