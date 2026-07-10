import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export const recipe = JSON.parse(readFileSync(join(here, 'recipe.json'), 'utf8'));
const themePromptTemplate = readFileSync(join(here, 'theme-prompt.txt'), 'utf8').trim();
const hex = new RegExp(recipe.pack.hexPattern);
const props = new Set(recipe.pack.props);

export function renderThemePrompt(prompt, avoid) {
  const avoidLine = avoid
    ? `The player rerolled: make this variant clearly different from the previous one named "${avoid}".\n`
    : '';
  return themePromptTemplate
    .replace('{{PLAYER_PROMPT}}', prompt || 'surprise me')
    .replace('{{AVOID_LINE}}', avoidLine);
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
