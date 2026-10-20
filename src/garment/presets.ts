/** Garment categories: where the garment sits on the body and which outline edges are open (not sewn). */
import type { Pattern } from './pattern';

export type PresetId = 'top' | 'sleeveless' | 'strap' | 'pants' | 'skirt' | 'custom';

export interface Preset {
  id: PresetId;
  label: string;
  /** Default garment length in cm (top of the photo's garment to its lowest edge). */
  length: number;
  /** Height fraction of the body at which the top edge of the garment is placed. */
  anchor: number;
  /** Hold the topmost edge (shoulder seams or waistband) at its height, as shoulders / a belt would. */
  holdTop: boolean;
  /** Hangs from the hips (skirt, dress, top) rather than splitting around each leg. */
  hangsFromHips: boolean;
  /** Decide which outline points are openings; nx,ny are normalised within the garment bbox (ny=0 top). */
  isOpening: (nx: number, ny: number) => boolean;
}

const hem = (ny: number) => ny > 0.96;
const waist = (ny: number) => ny < 0.04;
const neck = (nx: number, ny: number) => Math.abs(nx) < 0.14 && ny < 0.13;

export const PRESETS: Preset[] = [
  {
    id: 'top',
    hangsFromHips: true,
    label: 'Top with sleeves (t-shirt, shirt, sweater)',
    length: 70,
    anchor: 0.826,
    holdTop: true,
    isOpening: (nx, ny) => hem(ny) || neck(nx, ny) || Math.abs(nx) > 0.465,
  },
  {
    id: 'sleeveless',
    hangsFromHips: true,
    label: 'Sleeveless top / dress',
    length: 90,
    anchor: 0.826,
    holdTop: true,
    isOpening: (nx, ny) => hem(ny) || neck(nx, ny) || (ny < 0.3 && Math.abs(nx) > 0.15),
  },
  {
    id: 'strap',
    hangsFromHips: true,
    label: 'Strap or strapless dress / top (thin straps are ignored)',
    length: 100,
    anchor: 0.826,
    holdTop: true,
    // side seams run all the way up; only the hem and the top edge (neckline) are open
    isOpening: (nx, ny) => hem(ny) || ny < 0.045 || neck(nx, ny),
  },
  {
    id: 'pants',
    hangsFromHips: false,
    label: 'Trousers / jeans / shorts',
    length: 105,
    anchor: 0.64,
    holdTop: true,
    isOpening: (_nx, ny) => hem(ny) || waist(ny),
  },
  {
    id: 'skirt',
    hangsFromHips: true,
    label: 'Skirt',
    length: 60,
    anchor: 0.64,
    holdTop: true,
    isOpening: (_nx, ny) => hem(ny) || waist(ny),
  },
  {
    id: 'custom',
    hangsFromHips: true,
    label: 'Custom (paint the openings yourself)',
    length: 70,
    anchor: 0.826,
    holdTop: true,
    isOpening: (_nx, ny) => hem(ny) || waist(ny),
  },
];

export function getPreset(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id)!;
}

/** 1 for each boundary point (in pattern.boundary order) that should be an opening. */
export function autoOpenings(pattern: Pattern, preset: Preset): Uint8Array {
  const { bbox } = pattern;
  const W = bbox.maxX - bbox.minX;
  const H = bbox.maxY - bbox.minY;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const out = new Uint8Array(pattern.boundary.length);
  pattern.boundary.forEach((pi, k) => {
    const nx = (pattern.pts[pi * 2] - cx) / W;
    const ny = (pattern.pts[pi * 2 + 1] - bbox.minY) / H;
    out[k] = preset.isOpening(nx, ny) ? 1 : 0;
  });
  return out;
}

/** Estimate how far the sleeves point away from the body (degrees from vertical) from the outline. */
export function estimateArmAngle(
  pattern: Pattern,
  metersPerPx: number,
  topY: number,
  shoulderHalfWidth: number,
): number {
  const { bbox, pts, boundary } = pattern;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const jy = topY - 0.05;
  let best = 0;
  let angle = 25;
  for (const pi of boundary) {
    const x = (pts[pi * 2] - cx) * metersPerPx;
    const y = topY - (pts[pi * 2 + 1] - pattern.fullBBox.minY) * metersPerPx;
    const dx = Math.abs(x) - shoulderHalfWidth;
    const dy = jy - y;
    const dist = Math.hypot(dx, dy);
    if (dx > 0.05 && dist > best) {
      best = dist;
      angle = (Math.atan2(dx, dy) * 180) / Math.PI;
    }
  }
  return Math.max(8, Math.min(85, angle));
}

/** Width in px of the garment at pixel row `y`, for the run containing (or nearest to) column `cx`. */
export function widthAtRow(pattern: Pattern, y: number, cx: number): number | null {
  const { mask, w, h } = pattern;
  const row = Math.round(y);
  if (row < 0 || row >= h) return null;
  const x0 = Math.round(cx);
  if (!mask[row * w + x0]) return null;
  let l = x0;
  let r = x0;
  while (l > 0 && mask[row * w + l - 1]) l--;
  while (r < w - 1 && mask[row * w + r + 1]) r++;
  return r - l + 1;
}

/** Carry opening flags from one pattern of a garment to another (finer or coarser) by nearest outline point. */
export function transferOpenings(from: Pattern, fromOpen: Uint8Array, to: Pattern): Uint8Array {
  const out = new Uint8Array(to.boundary.length);
  to.boundary.forEach((pi, k) => {
    const u = to.pts[pi * 2] / to.w;
    const v = to.pts[pi * 2 + 1] / to.h;
    let best = Infinity;
    let flag = 0;
    from.boundary.forEach((qi, j) => {
      const d = (from.pts[qi * 2] / from.w - u) ** 2 + (from.pts[qi * 2 + 1] / from.h - v) ** 2;
      if (d < best) {
        best = d;
        flag = fromOpen[j];
      }
    });
    out[k] = flag;
  });
  return out;
}
