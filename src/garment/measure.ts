import type { BodyModel } from '../body';
import type { GarmentMeasure } from '../fit';
import { LANDMARKS } from '../body';
import type { Pattern } from './pattern';
import { widthAtRow } from './presets';

/** Garment circumference (cm) at the body's chest/waist/hip heights, assuming a flat-lay tube (2 x flat width). */
export function measureGarment(
  pattern: Pattern,
  body: BodyModel,
  metersPerPx: number,
  topY: number,
  stretch: number,
  hasSleeves = false,
): GarmentMeasure {
  const cx = (pattern.bbox.minX + pattern.bbox.maxX) / 2;
  // Rows above the armpit include the sleeves; measure the torso below them instead.
  let minRow = -Infinity;
  if (hasSleeves) {
    const { minY, maxY } = pattern.bbox;
    const ref = widthAtRow(pattern, minY + (maxY - minY) * 0.9, cx);
    if (ref) {
      for (let y = minY; y < minY + (maxY - minY) * 0.6; y++) {
        const w = widthAtRow(pattern, y, cx);
        if (w !== null && w > ref * 1.15) minRow = y + 3;
      }
    }
  }
  const at = (frac: number) => {
    const row = Math.max(minRow, pattern.bbox.minY + (topY - frac * body.height) / metersPerPx);
    const w = widthAtRow(pattern, row, cx);
    return w === null ? null : 2 * w * metersPerPx * 100;
  };
  return { chest: at(LANDMARKS.chest), waist: at(LANDMARKS.waist), hip: at(LANDMARKS.hip), stretch };
}

/**
 * Half width (metres) of the torso below the armpits of a top with sleeves, and the armpit row (px).
 * Null when the garment has no sleeves.
 */
export function torsoHalfWidth(pattern: Pattern, metersPerPx: number): number | null {
  const cx = (pattern.bbox.minX + pattern.bbox.maxX) / 2;
  const { minY, maxY } = pattern.bbox;
  const ref = widthAtRow(pattern, minY + (maxY - minY) * 0.9, cx);
  if (!ref) return null;
  let armpit = -1;
  for (let y = minY; y < minY + (maxY - minY) * 0.6; y++) {
    const w = widthAtRow(pattern, y, cx);
    if (w !== null && w > ref * 1.15) armpit = y;
  }
  if (armpit < 0) return null;
  const w = widthAtRow(pattern, armpit + 6, cx);
  return w === null ? null : (w / 2) * metersPerPx;
}
