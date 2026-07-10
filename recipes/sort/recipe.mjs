import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export const recipe = JSON.parse(readFileSync(join(here, 'recipe.json'), 'utf8'));
const themePromptTemplate = readFileSync(join(here, 'theme-prompt.txt'), 'utf8').trim();
const hex = new RegExp(recipe.pack.hexPattern);
const props = new Set(recipe.pack.props);
const enumFields = {
  difficulty: new Set(recipe.pack.difficulties),
  motion: new Set(recipe.pack.motions),
  marbleStyle: new Set(recipe.pack.marbleStyles),
  markerStyle: new Set(recipe.pack.markerStyles),
  targetShape: new Set(recipe.pack.targetShapes),
  conveyorPath: new Set(recipe.pack.conveyorPaths),
  sourceShape: new Set(recipe.pack.sourceShapes),
  backgroundPattern: new Set(recipe.pack.backgroundPatterns),
};

export function renderThemePrompt(prompt, avoid, preferences = {}) {
  const avoidLine = avoid
    ? `The player rerolled. Previous variant fingerprint: "${avoid}". Change at least three of material, marker, target shape, conveyor path, source shape, background pattern, difficulty, and motion while preserving the requested theme.\n`
    : '';
  return themePromptTemplate
    .replace('{{PLAYER_PROMPT}}', prompt || 'surprise me')
    .replace('{{DIFFICULTY_PREF}}', preferences.difficulty || 'surprise')
    .replace('{{MOTION_PREF}}', preferences.motion || 'surprise')
    .replace('{{AVOID_LINE}}', avoidLine);
}

export function finalizePack(pack, seed, preferences = {}) {
  const resolved = resolvePreferences(seed, preferences);
  return { ...pack, seed: Number(seed) >>> 0, ...resolved };
}

export function resolvePreferences(seed, preferences = {}) {
  const value = Number(seed) >>> 0;
  const difficulty = preferences.difficulty && preferences.difficulty !== 'surprise'
    ? preferences.difficulty
    : recipe.pack.difficulties[value % recipe.pack.difficulties.length];
  const motion = preferences.motion && preferences.motion !== 'surprise'
    ? preferences.motion
    : recipe.pack.motions[(value >>> 8) % recipe.pack.motions.length];
  return { difficulty, motion };
}

function luminance(color) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function validatePromptAdherence(pack, prompt) {
  const text = String(prompt || '').toLowerCase();
  const darkRequested = recipe.adherence.darkTerms.some((term) => text.includes(term));
  if (darkRequested && luminance(pack.sceneBg) > recipe.adherence.darkSceneMaxLuminance) {
    return `player explicitly requested a dark theme, but sceneBg ${pack.sceneBg} is too bright`;
  }
  if (darkRequested && luminance(pack.boardBg) > recipe.adherence.darkBoardMaxLuminance) {
    return `player explicitly requested a dark theme, but boardBg ${pack.boardBg} is too bright`;
  }
  return null;
}

export function validateRerollDifference(pack, fingerprint) {
  if (!fingerprint || !String(fingerprint).includes('|')) return null;
  const previous = String(fingerprint).split('|');
  const fields = ['marbleStyle', 'markerStyle', 'targetShape', 'conveyorPath', 'sourceShape', 'backgroundPattern', 'difficulty', 'motion'];
  const changed = fields.reduce((count, field, index) => count + (String(pack[field]) !== previous[index + 1] ? 1 : 0), 0);
  return changed >= 3 ? null : `reroll changed only ${changed} major traits; change at least 3`;
}

export function validatePack(pack) {
  if (!pack || typeof pack !== 'object') return 'pack must be an object';
  if (!Array.isArray(pack.items) || pack.items.length !== recipe.pack.itemCount || !pack.items.every((c) => typeof c === 'string' && hex.test(c))) {
    return `pack.items must be exactly ${recipe.pack.itemCount} #RRGGBB colors`;
  }
  for (const key of recipe.pack.colorFields) {
    if (typeof pack[key] !== 'string' || !hex.test(pack[key])) return `pack.${key} must be a #RRGGBB color`;
  }
  if (typeof pack.name !== 'string' || !pack.name.trim()) return 'pack.name must be a non-empty string';
  if (typeof pack.prop !== 'string' || !props.has(pack.prop)) return `pack.prop must be one of ${recipe.pack.props.join('/')}`;
  if (!Number.isInteger(pack.seed) || pack.seed < 0 || pack.seed > 0xffffffff) return 'pack.seed must be an unsigned 32-bit integer';
  for (const [key, allowed] of Object.entries(enumFields)) {
    if (typeof pack[key] !== 'string' || !allowed.has(pack[key])) {
      return `pack.${key} must be one of ${[...allowed].join('/')}`;
    }
  }

  const rgbs = pack.items.map((color) => [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)));
  for (let i = 0; i < rgbs.length; i++) {
    for (let j = i + 1; j < rgbs.length; j++) {
      const distance = rgbs[i].reduce((sum, channel, k) => sum + Math.abs(channel - rgbs[j][k]), 0);
      if (distance < recipe.pack.minPairwiseRgbDistance) {
        return `marble colors ${pack.items[i]} and ${pack.items[j]} are too similar; use more distinct hues (you may bend realism for gameplay)`;
      }
    }
  }
  return null;
}
