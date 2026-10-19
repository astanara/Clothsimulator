import { describe, expect, it } from 'vitest';
import { demoScanMesh } from './demoScan';
import { RawMesh, bounds, normalizeScan, rotateY, toSoup } from './normalize';
import { ScanData } from './scanBody';

/** Z-up, facing -y, in centimetres, as many scanners export. */
function scannerFrame(m: RawMesh, turns = 0): RawMesh {
  const p = turns ? rotateY(m.pos, turns) : Float32Array.from(m.pos);
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] * 100;
    out[i + 1] = -p[i + 2] * 100;
    out[i + 2] = p[i + 1] * 100;
  }
  return { pos: out, idx: m.idx };
}

describe('scan normalisation', () => {
  const src = demoScanMesh();
  it('restores up axis, scale and facing from a z-up scan', () => {
    const n = normalizeScan(scannerFrame(src), 175);
    const b = bounds(n.pos);
    expect(b.mn[1]).toBeCloseTo(0, 3);
    expect(b.mx[1]).toBeCloseTo(1.75, 2);
    // toes point to +z: foot vertices lie further forward than shin vertices
    let foot = 0, nf = 0, shin = 0, ns = 0;
    for (let i = 0; i < n.pos.length; i += 3) {
      if (n.pos[i + 1] < 0.08) { foot += n.pos[i + 2]; nf++; }
      else if (n.pos[i + 1] > 0.25 && n.pos[i + 1] < 0.5) { shin += n.pos[i + 2]; ns++; }
    }
    expect(foot / nf).toBeGreaterThan(shin / ns);
  });
  it('finds the facing direction when the scan is turned', () => {
    for (const turns of [1, 2, 3]) {
      const n = normalizeScan(scannerFrame(src, turns), 175);
      let foot = 0, nf = 0, shin = 0, ns = 0;
      for (let i = 0; i < n.pos.length; i += 3) {
        if (n.pos[i + 1] < 0.08) { foot += n.pos[i + 2]; nf++; }
        else if (n.pos[i + 1] > 0.25 && n.pos[i + 1] < 0.5) { shin += n.pos[i + 2]; ns++; }
      }
      expect(foot / nf).toBeGreaterThan(shin / ns);
    }
  });
});

describe('scan body', () => {
  const norm = normalizeScan(scannerFrame(demoScanMesh()), 175);
  const scan = new ScanData(toSoup(norm), 1.75);
  it('has a signed distance field: inside < 0 < outside', () => {
    const c = scan.collider(false);
    expect(c.distance(0, 1.12, 0)).toBeLessThan(-0.05);
    expect(c.distance(0.3, 0.7, 0)).toBeGreaterThan(0.03);
    // surface of the waist ellipsoid is x = 0.15 at y = 1.12
    expect(Math.abs(c.distance(0.15, 1.12, 0))).toBeLessThan(0.02);
  });
  it('pushes points out of the body', () => {
    const c = scan.collider(false);
    const p = { x: 0.1, y: 1.12, z: 0 };
    expect(c.collide(p, 0.005)).toBe(true);
    expect(Math.abs(p.x)).toBeGreaterThan(0.14);
  });
  it('reads measurements, crotch height and arm angle from the scan', () => {
    const m = scan.measurements;
    expect(m.chest).toBeGreaterThan(85);
    expect(m.chest).toBeLessThan(125);
    expect(m.waist).toBeLessThan(m.chest);
    expect(m.hip).toBeGreaterThan(85);
    expect(scan.crotchY).toBeGreaterThan(0.6);
    expect(scan.crotchY).toBeLessThan(0.95);
    expect(scan.armAngle).toBeGreaterThan(20);
    expect(scan.armAngle).toBeLessThan(45);
  });
  it('can close the gap between the legs', () => {
    const open = scan.collider(false);
    const filled = scan.collider(true);
    const y = scan.crotchY - 0.05;
    expect(open.distance(0, y, 0)).toBeGreaterThan(0);
    expect(filled.distance(0, y, 0)).toBeLessThan(0);
  });
});
