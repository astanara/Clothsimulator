import { describe, expect, it } from 'vitest';
import { Body, DEFAULT_BODY, ellipseFromCircumference, ellipsePerimeter } from './body';
import { Cloth } from './cloth';
import { analyseFit, classify } from './fit';
import { measureGarment } from './garment/measure';
import { buildPattern } from './garment/pattern';
import { autoOpenings, getPreset } from './garment/presets';
import { segment } from './image/segment';
import { SAMPLES, rasteriseOutline } from './samples';

describe('body', () => {
  it('reproduces requested circumference', () => {
    const { a, b } = ellipseFromCircumference(1.0, 0.7);
    expect(ellipsePerimeter(a, b)).toBeCloseTo(1.0, 5);
  });
  it('matches chest measurement at the chest landmark', () => {
    const body = new Body(DEFAULT_BODY);
    expect(body.circumferenceAt(0.72) * 100).toBeCloseTo(DEFAULT_BODY.chest, 0);
  });
  it('collision pushes points out of torso and arms', () => {
    const body = new Body(DEFAULT_BODY);
    const p = { x: 0.01, y: 0.72 * body.height, z: 0.01 };
    expect(body.collide(p, 0)).toBe(true);
    expect(body.distance(p.x, p.y, p.z)).toBeCloseTo(0, 2);
    const arm = body.capsules[2];
    const q = { x: arm.b[0], y: arm.b[1], z: 0 };
    expect(body.collide(q, 0)).toBe(true);
    expect(Math.abs(q.z) + Math.abs(q.x - arm.b[0]) + Math.abs(q.y - arm.b[1])).toBeGreaterThan(0.02);
  });
});

describe('fit', () => {
  it('classifies ease', () => {
    expect(classify(-10, 0.05, 98)).toBe('too tight');
    expect(classify(-3, 0.05, 98)).toBe('snug');
    expect(classify(8, 0.05, 98)).toBe('regular');
    expect(classify(25, 0.05, 98)).toBe('too loose');
  });
  it('skips regions the garment does not cover', () => {
    const rows = analyseFit(DEFAULT_BODY, { chest: 110, waist: null, hip: null, stretch: 0.03 });
    expect(rows.map((r) => r.region)).toEqual(['chest']);
  });
});

function pipeline(id: string) {
  const def = SAMPLES.find((s) => s.id === id)!;
  const rgba = rasteriseOutline(def.outline);
  const seg = segment(rgba, 400, 400);
  const pattern = buildPattern(seg.mask, 400, 400)!;
  return { def, seg, pattern };
}

describe('photo -> pattern', () => {
  for (const s of SAMPLES) {
    it(`segments and meshes the ${s.id} sample`, () => {
      const { seg, pattern } = pipeline(s.id);
      const area = seg.mask.reduce((a, v) => a + v, 0);
      expect(area).toBeGreaterThan(8000);
      expect(pattern).toBeTruthy();
      expect(pattern.tris.length / 3).toBeGreaterThan(100);
      // every triangle's centroid lies on the garment
      for (let t = 0; t < pattern.tris.length; t += 3) {
        let cx = 0;
        let cy = 0;
        for (let e = 0; e < 3; e++) {
          cx += pattern.pts[pattern.tris[t + e] * 2] / 3;
          cy += pattern.pts[pattern.tris[t + e] * 2 + 1] / 3;
        }
        const x0 = Math.floor(cx - 0.5);
        const y0 = Math.floor(cy - 0.5);
        const hit = [0, 1].some((dy) => [0, 1].some((dx) => seg.mask[(y0 + dy) * 400 + x0 + dx] === 1));
        expect(hit).toBe(true);
      }
    });
  }
  it('uses alpha when the photo is a cut-out', () => {
    const rgba = rasteriseOutline(SAMPLES[0].outline);
    for (let i = 0; i < 400 * 400; i++) if (rgba[i * 4] > 200) rgba[i * 4 + 3] = 0;
    const seg = segment(rgba, 400, 400);
    expect(seg.usedAlpha).toBe(true);
    expect(seg.mask.reduce((a, v) => a + v, 0)).toBeGreaterThan(8000);
  });
  it('marks hem, neck and cuffs of a t-shirt as openings, leaving side seams', () => {
    const { pattern } = pipeline('tshirt');
    const open = autoOpenings(pattern, getPreset('top'));
    const n = open.reduce((a, v) => a + v, 0);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(open.length * 0.6);
  });
});

describe('cloth drape', () => {
  const drape = (id: string, scaleLength: number) => {
    const { def, pattern } = pipeline(id);
    const preset = getPreset(def.preset);
    const body = new Body(DEFAULT_BODY, 35, preset.hangsFromHips);
    const s = (scaleLength / 100) / (pattern.bbox.maxY - pattern.bbox.minY);
    const cloth = new Cloth({
      body,
      pattern,
      openings: autoOpenings(pattern, preset),
      metersPerPx: s,
      topY: preset.anchor * body.height,
      holdTop: preset.holdTop,
      stiffness: 1,
      bend: 0.3,
    });
    cloth.settle(200);
    return { cloth, body, pattern, s, preset };
  };
  for (const id of ['tshirt', 'pants', 'dress', 'skirt']) {
    it(`${id}: stays finite and outside the body`, () => {
      const { cloth } = drape(id, getPreset(SAMPLES.find((x) => x.id === id)!.preset).length);
      for (const v of cloth.pos) expect(Number.isFinite(v)).toBe(true);
      for (let i = 0; i < cloth.count; i++) expect(cloth.gap[i]).toBeGreaterThan(-0.01);
    });
  }
  it('a smaller garment is more strained than a larger one', () => {
    const mean = (c: Cloth) => c.strain.reduce((a, v) => a + v, 0) / c.count;
    expect(mean(drape('tshirt', 60).cloth)).toBeGreaterThan(mean(drape('tshirt', 78).cloth));
  });
  it('measures garment circumference from the pattern', () => {
    const { pattern, s, body, preset } = drape('tshirt', 70);
    const m = measureGarment(pattern, body, s, preset.anchor * body.height, 0.03, true);
    expect(m.chest).toBeGreaterThan(80);
    expect(m.chest).toBeLessThan(130);
  });
});
