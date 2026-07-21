import CHARACTER_1 from '../assets/generated/__ART_PACK_HASH__/character-order-1.png?inline';
import CHARACTER_2 from '../assets/generated/__ART_PACK_HASH__/character-order-2.png?inline';
import CHARACTER_3 from '../assets/generated/__ART_PACK_HASH__/character-order-3.png?inline';

const CHAR_CANVAS_W = 220;
const CHAR_CANVAS_H = 420;
const CHAR_RENDER_SCALE = 0.2;
const CHAR_ANCHOR_X_FRAC = 0.5;
const CHAR_ANCHOR_Y_FRAC = 0.65;
const characterImages = [CHARACTER_1, CHARACTER_2, CHARACTER_3].map((source) => {
  const image = new Image();
  image.src = source;
  return image;
});

export function initSpine(callback?: () => void, _staggered = false): void {
  const ready = Promise.all(characterImages.map((image) => image.decode?.().catch(() => undefined)));
  ready.finally(() => callback?.());
}

export function isSpineReady(): boolean { return true; }
export function isSpineWebGLReady(): boolean { return false; }
export function getCharCount(): number { return characterImages.length; }
export function setAnimation(_charIdx: number, _name: string, _loop = true): void {}

export function drawAllSpine(
  context: CanvasRenderingContext2D,
  positions: { charIdx: number; x: number; y: number; scale: number; alpha?: number }[],
  _logW: number,
  _logH: number,
): void {
  for (const position of positions) {
    const image = characterImages[position.charIdx];
    if (!image?.complete || image.naturalWidth < 1 || (position.alpha ?? 1) < 0.01) continue;
    const scaleRatio = position.scale / CHAR_RENDER_SCALE;
    const width = CHAR_CANVAS_W * scaleRatio;
    const height = CHAR_CANVAS_H * scaleRatio;
    context.save();
    context.globalAlpha *= position.alpha ?? 1;
    context.drawImage(
      image,
      position.x - CHAR_ANCHOR_X_FRAC * width,
      position.y - CHAR_ANCHOR_Y_FRAC * height,
      width,
      height,
    );
    context.restore();
  }
}

let fingerStartedAt = 0;
let fingerFrozen = false;
export function initFinger(): void {}
export function isFingerReady(): boolean { return true; }
export function isFingerWebGLReady(): boolean { return false; }
export function setFingerAnimation(_name: string, _loop = true, withTapEffect = false): void {
  fingerStartedAt = withTapEffect ? Date.now() : 0;
  fingerFrozen = false;
}
export function freezeFingerAnimation(_atTime = 0.5): void { fingerFrozen = true; }

export function drawFinger(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  _logW: number,
  _logH: number,
  options: { rotation?: number; alpha?: number; scaleMul?: number; tapEffect?: boolean } = {},
): void {
  const elapsed = fingerStartedAt && !fingerFrozen ? Date.now() - fingerStartedAt : 0;
  const pulse = options.tapEffect === false ? 0 : Math.max(0, 1 - elapsed / 800);
  const radius = 30 * scale * (options.scaleMul ?? 1) * (1 - pulse * 0.12);
  context.save();
  context.globalAlpha *= options.alpha ?? 0.92;
  context.translate(x, y);
  context.rotate(options.rotation ?? -0.28);
  context.fillStyle = '#FFF7EA';
  context.strokeStyle = 'rgba(45,35,55,0.58)';
  context.lineWidth = Math.max(1.5, radius * 0.08);
  context.beginPath();
  context.roundRect(-radius * 0.35, -radius * 1.2, radius * 0.7, radius * 1.55, radius * 0.32);
  context.fill();
  context.stroke();
  context.beginPath();
  context.arc(0, -radius * 1.22, radius * 0.35, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  if (pulse > 0) {
    context.strokeStyle = `rgba(255,220,90,${pulse * 0.8})`;
    context.lineWidth = Math.max(2, radius * 0.1);
    context.beginPath();
    context.arc(0, -radius * 1.22, radius * (0.6 + (1 - pulse) * 0.7), 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}
