export interface SortRecipe {
  version: number;
  template: 'sort';
  baseBuild: string;
  generatorBase: string;
  generatorBaseline: string;
  sourcePalette: string[];
  payloadScript: string;
  boardColor: string;
  pack: {
    itemCount: number;
    hexPattern: string;
    minPairwiseRgbDistance: number;
    props: string[];
    colorFields: string[];
  };
}

export const recipe: SortRecipe;
export function renderThemePrompt(prompt: string, avoid?: string): string;
export function validatePack(pack: Record<string, unknown>): string | null;
