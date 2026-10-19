/** Measurement-based fit analysis (all units cm). */
import type { BodyMeasurements } from './body';

export interface Garment {
  name: string;
  /** Flat garment circumferences (full circumference, not half-width). */
  chest: number;
  waist: number;
  hem: number;
  /** Garment length shoulder-to-hem. */
  length: number;
  /** Fabric stretch: fraction the cloth may extend comfortably (0.05 = 5%). */
  stretch: number;
}

export type Verdict = 'too tight' | 'snug' | 'regular' | 'loose' | 'too loose';

export interface RegionFit {
  region: 'chest' | 'waist' | 'hip';
  body: number;
  garment: number;
  ease: number;
  verdict: Verdict;
}

export function classify(ease: number, stretch: number, bodyCirc: number): Verdict {
  // Stretch fabric can absorb negative ease.
  const effective = ease + stretch * bodyCirc;
  if (effective < 0) return 'too tight';
  if (ease < 4) return 'snug';
  if (ease < 12) return 'regular';
  if (ease < 20) return 'loose';
  return 'too loose';
}

export function analyseFit(body: BodyMeasurements, g: Garment): RegionFit[] {
  const rows: [RegionFit['region'], number, number][] = [
    ['chest', body.chest, g.chest],
    ['waist', body.waist, g.waist],
    ['hip', body.hip, g.hem],
  ];
  return rows.map(([region, b, gc]) => {
    const ease = gc - b;
    return { region, body: b, garment: gc, ease, verdict: classify(ease, g.stretch, b) };
  });
}

const PENALTY: Record<Verdict, number> = {
  'too tight': 10,
  snug: 1,
  regular: 0,
  loose: 1.5,
  'too loose': 6,
};

export function fitScore(body: BodyMeasurements, g: Garment): number {
  const fits = analyseFit(body, g);
  const pen = fits.reduce((s, f) => s + PENALTY[f.verdict] + Math.abs(f.ease - 8) * 0.02, 0);
  return Math.max(0, Math.round(100 - pen * 5));
}

/** Standard size chart: garment measurements for a regular-fit shirt. */
export const SIZE_CHART: Garment[] = [
  { name: 'S', chest: 94, waist: 90, hem: 94, length: 68, stretch: 0.05 },
  { name: 'M', chest: 102, waist: 98, hem: 102, length: 70, stretch: 0.05 },
  { name: 'L', chest: 110, waist: 106, hem: 110, length: 72, stretch: 0.05 },
  { name: 'XL', chest: 118, waist: 114, hem: 118, length: 74, stretch: 0.05 },
  { name: 'XXL', chest: 126, waist: 122, hem: 126, length: 76, stretch: 0.05 },
];

export function recommendSize(body: BodyMeasurements, chart: Garment[] = SIZE_CHART) {
  const scored = chart.map((g) => ({ garment: g, score: fitScore(body, g) }));
  scored.sort((x, y) => y.score - x.score);
  return scored;
}
