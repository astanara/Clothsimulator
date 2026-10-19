/** Built-in demo garment "photos", drawn on a canvas on a plain background. */
import type { PresetId } from './garment/presets';

export type Pt = [number, number];

export interface SampleDef {
  id: string;
  label: string;
  preset: PresetId;
  color: string;
  /** Outline in a 400x400 canvas. */
  outline: Pt[];
  decorate: (ctx: CanvasRenderingContext2D) => void;
}

const mirror = (half: Pt[]): Pt[] => [...half, ...half.map(([x, y]) => [400 - x, y] as Pt).reverse()];

export const SAMPLES: SampleDef[] = [
  {
    id: 'tshirt',
    label: 'Sample: striped t-shirt',
    preset: 'top',
    color: '#d9534f',
    // left half from the neck dip down to the hem centre, then mirrored
    outline: mirror([
      [200, 88],
      [165, 80],
      [150, 58],
      [112, 66],
      [40, 118],
      [22, 150],
      [58, 188],
      [98, 158],
      [100, 358],
      [200, 358],
    ]),
    decorate(ctx) {
      ctx.fillStyle = '#f6f1e7';
      for (let y = 190; y < 350; y += 36) ctx.fillRect(100, y, 200, 14);
      ctx.fillStyle = '#1d2b53';
      ctx.beginPath();
      ctx.arc(200, 130, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('FIT', 200, 138);
    },
  },
  {
    id: 'pants',
    label: 'Sample: jeans',
    preset: 'pants',
    color: '#2f4a7d',
    outline: mirror([
      [200, 40],
      [200, 190],
      [176, 378],
      [136, 382],
      [124, 150],
      [130, 40],
    ]),
    decorate(ctx) {
      ctx.strokeStyle = '#e0b66a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(136, 58);
      ctx.quadraticCurveTo(160, 100, 192, 58);
      ctx.moveTo(208, 58);
      ctx.quadraticCurveTo(240, 100, 264, 58);
      ctx.moveTo(200, 40);
      ctx.lineTo(200, 190);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(124, 40, 152, 12);
    },
  },
  {
    id: 'dress',
    label: 'Sample: floral dress',
    preset: 'sleeveless',
    color: '#8e5ea2',
    outline: mirror([
      [200, 84],
      [172, 76],
      [158, 24],
      [136, 24],
      [110, 112],
      [97, 150],
      [104, 236],
      [50, 382],
      [200, 382],
    ]),
    decorate(ctx) {
      for (let i = 0; i < 60; i++) {
        const x = 70 + ((i * 97) % 260);
        const y = 40 + ((i * 53) % 340);
        ctx.fillStyle = i % 2 ? '#f4c2d7' : '#ffe9a8';
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  {
    id: 'skirt',
    label: 'Sample: plaid skirt',
    preset: 'skirt',
    color: '#2e7d5b',
    outline: mirror([
      [200, 40],
      [200 - 80, 40],
      [200 - 150, 300],
      [200, 300],
    ]),
    decorate(ctx) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 4;
      for (let x = 40; x < 360; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 30);
        ctx.lineTo(x, 310);
        ctx.stroke();
      }
      for (let y = 50; y < 300; y += 32) {
        ctx.beginPath();
        ctx.moveTo(30, y);
        ctx.lineTo(370, y);
        ctx.stroke();
      }
    },
  },
];

export function drawSample(def: SampleDef, size = 400): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.scale(size / 400, size / 400);
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, 400, 400);
  ctx.save();
  ctx.beginPath();
  def.outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = def.color;
  ctx.fill();
  ctx.clip();
  def.decorate(ctx);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  def.outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  return c;
}

/** Rasterise a sample's outline to an RGBA buffer (no canvas needed, used by tests). */
export function rasteriseOutline(outline: Pt[], size = 400): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = false;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const [xi, yi] = outline[i];
        const [xj, yj] = outline[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      const k = (y * size + x) * 4;
      const v = inside ? 60 : 236;
      data[k] = v;
      data[k + 1] = inside ? 90 : 236;
      data[k + 2] = inside ? 160 : 236;
      data[k + 3] = 255;
    }
  }
  return data;
}
