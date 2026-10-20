/** Measurement-based fit analysis (all units cm). */
import type { BodyMeasurements } from './body';

export type Verdict = 'too tight' | 'snug' | 'regular' | 'loose' | 'too loose';

export interface RegionFit {
  region: 'chest' | 'waist' | 'hip';
  body: number;
  garment: number;
  ease: number;
  verdict: Verdict;
}

/** Garment circumferences measured from the flat pattern (null where the garment does not cover that height). */
export interface GarmentMeasure {
  chest: number | null;
  waist: number | null;
  hip: number | null;
  /** Fabric stretch: fraction the cloth may extend comfortably (0.05 = 5%). */
  stretch: number;
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

export function analyseFit(body: BodyMeasurements, g: GarmentMeasure): RegionFit[] {
  const rows: [RegionFit['region'], number, number | null][] = [
    ['chest', body.chest, g.chest],
    ['waist', body.waist, g.waist],
    ['hip', body.hip, g.hip],
  ];
  const out: RegionFit[] = [];
  for (const [region, b, gc] of rows) {
    if (gc === null) continue;
    const ease = gc - b;
    out.push({ region, body: b, garment: gc, ease, verdict: classify(ease, g.stretch, b) });
  }
  return out;
}

export const FABRICS = {
  woven: { label: 'Woven (cotton, denim)', stretch: 0.03, stiffness: 1, bend: 0.3 },
  knit: { label: 'Knit (jersey, sweater)', stretch: 0.12, stiffness: 0.7, bend: 0.12 },
  elastic: { label: 'Very stretchy (lycra)', stretch: 0.3, stiffness: 0.4, bend: 0.08 },
} as const;
export type FabricId = keyof typeof FABRICS;

export const SIZES = [
  { name: 'S', scale: 0.93 },
  { name: 'M', scale: 1 },
  { name: 'L', scale: 1.07 },
  { name: 'XL', scale: 1.14 },
  { name: 'XXL', scale: 1.21 },
];

const PENALTY: Record<Verdict, number> = {
  'too tight': 10,
  snug: 1,
  regular: 0,
  loose: 1.5,
  'too loose': 6,
};
const SEVERITY: Verdict[] = ['regular', 'snug', 'loose', 'too loose', 'too tight'];

export interface SizeRow {
  name: string;
  scale: number;
  fits: RegionFit[];
  /** 0..100, higher is a better fit */
  score: number;
  worst: Verdict;
}

/**
 * Compare every size (the photo scaled by each size factor) against the body.
 * @param measureAt garment circumferences when the photo is scaled by `scale`
 */
export function sizeTable(body: BodyMeasurements, measureAt: (scale: number) => GarmentMeasure): SizeRow[] {
  return SIZES.map((sz) => {
    const fits = analyseFit(body, measureAt(sz.scale));
    const pen = fits.reduce((a, f) => a + PENALTY[f.verdict] + Math.abs(f.ease - 8) * 0.02, 0);
    const worst = fits.reduce<Verdict>(
      (w, f) => (SEVERITY.indexOf(f.verdict) > SEVERITY.indexOf(w) ? f.verdict : w),
      'regular',
    );
    return { name: sz.name, scale: sz.scale, fits, score: fits.length ? Math.max(0, Math.round(100 - pen * 5)) : 0, worst };
  });
}
