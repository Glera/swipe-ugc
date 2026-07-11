import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizePack,
  renderThemePrompt,
  validatePack,
  validatePromptAdherence,
  validateRerollDifference,
} from '../recipes/sort/recipe.mjs';

const validPack = {
  name: 'Obsidian Signal',
  items: ['#E63946', '#2A9D8F', '#F4D35E', '#4361EE', '#F72585', '#90BE6D'],
  ground: '#30343F',
  edge: '#1B1E25',
  sceneBg: '#08090D',
  boardBg: '#151820',
  belt: '#282D38',
  outline: '#BFC7D5',
  body: '#3B414E',
  roof: '#E63946',
  prop: 'crystal',
  seed: 12345,
  difficulty: 'hard',
  motion: 'heavy',
  marbleStyle: 'obsidian',
  markerStyle: 'glyphs',
  targetShape: 'hex',
  conveyorPath: 'compact',
  sourceShape: 'silo',
  backgroundPattern: 'grid',
};

test('canonical sort recipe accepts a complete generated pack', () => {
  assert.equal(validatePack(validPack), null);
});

test('canonical prompt includes the player brief and explicit preferences', () => {
  const prompt = renderThemePrompt('black industrial night', undefined, { difficulty: 'expert', motion: 'calm' });
  assert.match(prompt, /black industrial night/);
  assert.match(prompt, /Difficulty preference: expert/);
  assert.match(prompt, /Motion preference: calm/);
  assert.match(prompt, /does NOT need a bright rainbow/);
});

test('dark prompt adherence rejects a bright environment', () => {
  const bright = { ...validPack, sceneBg: '#EEEEEE' };
  assert.match(validatePromptAdherence(bright, 'make it dark and restrained'), /too bright/);
});

test('explicit difficulty and motion survive deterministic finalization', () => {
  const finalized = finalizePack(validPack, 0xffffffff, { difficulty: 'easy', motion: 'bouncy' });
  assert.equal(finalized.seed, 0xffffffff);
  assert.equal(finalized.difficulty, 'easy');
  assert.equal(finalized.motion, 'bouncy');
});

test('reroll gate requires at least three major trait changes', () => {
  const fingerprint = [validPack.name, validPack.marbleStyle, validPack.markerStyle, validPack.targetShape,
    validPack.conveyorPath, validPack.sourceShape, validPack.backgroundPattern, validPack.difficulty, validPack.motion].join('|');
  assert.match(validateRerollDifference({ ...validPack, motion: 'calm' }, fingerprint), /changed only 1/);
  assert.equal(validateRerollDifference({
    ...validPack,
    motion: 'calm',
    difficulty: 'expert',
    conveyorPath: 'wave',
  }, fingerprint), null);
});
