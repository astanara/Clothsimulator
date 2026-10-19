import { describe, expect, it } from 'vitest';
import { Body, DEFAULT_BODY, ellipseFromCircumference, ellipsePerimeter } from './body';
import { Cloth } from './cloth';
import { SIZE_CHART, analyseFit, classify, recommendSize } from './fit';

describe('body', () => {
  it('reproduces requested circumference', () => {
    const { a, b } = ellipseFromCircumference(1.0, 0.7);
    expect(ellipsePerimeter(a, b)).toBeCloseTo(1.0, 5);
  });
  it('matches chest measurement at the chest landmark', () => {
    const body = new Body(DEFAULT_BODY);
    expect(body.circumferenceAt(0.72) * 100).toBeCloseTo(DEFAULT_BODY.chest, 0);
  });
  it('collision pushes points to the surface', () => {
    const body = new Body(DEFAULT_BODY);
    const p = { x: 0.01, y: 0.72 * body.height, z: 0.01 };
    expect(body.collide(p, 0)).toBe(true);
    expect(body.radialRatio(p.x, p.y, p.z)).toBeCloseTo(1, 3);
  });
});

describe('fit', () => {
  it('classifies ease', () => {
    expect(classify(-10, 0.05, 98)).toBe('too tight');
    expect(classify(-3, 0.05, 98)).toBe('snug');
    expect(classify(8, 0.05, 98)).toBe('regular');
    expect(classify(25, 0.05, 98)).toBe('too loose');
  });
  it('recommends a larger size for a larger body', () => {
    const small = recommendSize({ ...DEFAULT_BODY, chest: 88, waist: 74, hip: 92 })[0].garment.name;
    const big = recommendSize({ ...DEFAULT_BODY, chest: 118, waist: 108, hip: 118 })[0].garment.name;
    expect(SIZE_CHART.findIndex((g) => g.name === big)).toBeGreaterThan(
      SIZE_CHART.findIndex((g) => g.name === small),
    );
  });
  it('reports region fits', () => {
    expect(analyseFit(DEFAULT_BODY, SIZE_CHART[1])).toHaveLength(3);
  });
});

describe('cloth', () => {
  const settled = (garmentIdx: number) => {
    const c = new Cloth(new Body(DEFAULT_BODY), SIZE_CHART[garmentIdx]);
    c.settle(250);
    return c;
  };
  it('stays finite and outside the body', () => {
    const c = settled(1);
    for (const v of c.pos) expect(Number.isFinite(v)).toBe(true);
    for (let i = 0; i < c.count; i++) expect(c.gap[i]).toBeGreaterThan(0.98);
  });
  it('a small size is more strained than a large size', () => {
    const mean = (c: Cloth) => c.strain.reduce((s, v) => s + v, 0) / c.count;
    expect(mean(settled(0))).toBeGreaterThan(mean(settled(3)));
  });
});
