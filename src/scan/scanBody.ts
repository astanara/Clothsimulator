/** A body scan prepared for the simulator: collision field plus measurements read from the scan. */
import type { BodyMeasurements, BodyModel } from '../body';
import { LANDMARKS } from '../body';
import { SDFGrid, buildSDF } from './sdf';

type Pt = [number, number];

export class ScanData {
  readonly height: number;
  readonly voxel: number;
  private readonly base: SDFGrid;
  private filled: SDFGrid | null = null;
  readonly measurements: BodyMeasurements;
  readonly shoulderHalfWidth: number;
  /** Arm angle from vertical in degrees, read from the scan's pose. */
  readonly armAngle: number;
  readonly crotchY: number;
  /** Height of the shoulder line where tops rest (shoulders are ~28 cm wide here). */
  readonly shoulderLineY: number;

  /** @param tris triangle soup in the simulator frame (y up, feet at 0, facing +z). */
  constructor(readonly tris: Float32Array, heightM: number) {
    this.height = heightM;
    this.voxel = Math.min(0.012, Math.max(0.007, heightM / 200));
    this.base = buildSDF(tris, { voxel: this.voxel });
    this.crotchY = this.findCrotch();
    const H = this.height;
    const limit = 0.27 * (H / 1.75);
    const circ = (lo: number, hi: number, pick: 'max' | 'min', xLimit: number) => {
      let best = pick === 'max' ? -Infinity : Infinity;
      let at = 0;
      for (let f = lo; f <= hi + 1e-9; f += 0.01) {
        const c = this.circumference(f * H, xLimit);
        if (c > 0 && (pick === 'max' ? c > best : c < best)) {
          best = c;
          at = f;
        }
      }
      return { cm: Number.isFinite(best) ? best * 100 : 0, at };
    };
    // The waist and hip are usually clear of the arms; the chest and shoulders are limited to a
    // multiple of the waist width so arms resting against the torso are not measured as chest.
    const waist = circ(0.58, 0.68, 'min', limit);
    const hip = circ(0.46, 0.56, 'max', limit);
    const waistWidth = this.widthAt(waist.at * H, limit);
    const torsoLimit = Math.max(0.2 * (H / 1.75), 0.7 * waistWidth);
    const chest = circ(0.68, 0.76, 'max', torsoLimit);
    this.shoulderHalfWidth = Math.min(0.28, Math.max(0.16, this.widthAt(0.81 * H, torsoLimit * 1.2) / 2));
    this.measurements = {
      height: H * 100,
      chest: round1(chest.cm),
      waist: round1(waist.cm),
      hip: round1(hip.cm),
      shoulderWidth: round1(this.shoulderHalfWidth * 200),
    };
    this.armAngle = this.estimateArmAngle();
    this.shoulderLineY = this.findShoulderLine(limit);
  }

  /** Collision model; `fillGap` closes the gap between the legs for skirts, dresses and long tops. */
  collider(fillGap: boolean): ScanCollider {
    if (!fillGap) return new ScanCollider(this.base, this.height);
    if (!this.filled) {
      const y1 = this.crotchY;
      this.filled = buildSDF(this.tris, {
        voxel: this.voxel,
        fillGap: { y0: y1 - 0.14 * this.height, y1, maxGap: 0.14 },
      });
    }
    return new ScanCollider(this.filled, this.height);
  }

  /** Cells of the inside set in the horizontal slice at height y, as [i,k] indices. */
  private slice(y: number) {
    const g = this.base;
    const j = Math.round((y - g.oy) / g.voxel);
    return { g, j };
  }

  private torsoPoints(y: number, xLimit: number): Pt[] {
    const { g, j } = this.slice(y);
    if (j < 0 || j >= g.ny) return [];
    const { nx, nz, ny } = g;
    const inside = (i: number, k: number) => g.data[i + j * nx + k * nx * ny] < 0;
    const label = new Int32Array(nx * nz);
    const comps: { cells: number[]; hasCentre: boolean }[] = [];
    for (let k0 = 0; k0 < nz; k0++) {
      for (let i0 = 0; i0 < nx; i0++) {
        if (!inside(i0, k0) || label[i0 + k0 * nx]) continue;
        const comp = { cells: [] as number[], hasCentre: false };
        const stack = [i0 + k0 * nx];
        label[i0 + k0 * nx] = comps.length + 1;
        while (stack.length) {
          const c = stack.pop()!;
          comp.cells.push(c);
          const i = c % nx;
          const k = (c / nx) | 0;
          if (Math.abs(g.ox + i * g.voxel) < 0.1) comp.hasCentre = true;
          for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ni = i + di;
            const nk = k + dk;
            if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
            if (inside(ni, nk) && !label[ni + nk * nx]) {
              label[ni + nk * nx] = comps.length + 1;
              stack.push(ni + nk * nx);
            }
          }
        }
        comps.push(comp);
      }
    }
    let best: number[] = [];
    for (const c of comps) if (c.hasCentre && c.cells.length > best.length) best = c.cells;
    const pts: Pt[] = [];
    for (const c of best) {
      const x = g.ox + (c % nx) * g.voxel;
      if (Math.abs(x) <= xLimit) pts.push([x, g.oz + ((c / nx) | 0) * g.voxel]);
    }
    return pts;
  }

  /** Tape-measure circumference (convex hull) of the torso at height y, in metres; 0 if nothing there. */
  circumference(y: number, xLimit: number): number {
    const pts = this.torsoPoints(y, xLimit);
    if (pts.length < 8) return 0;
    const hull = convexHull(pts);
    let p = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      p += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    return p + Math.PI * this.voxel;
  }

  widthAt(y: number, xLimit: number): number {
    const pts = this.torsoPoints(y, xLimit);
    if (!pts.length) return 0.4;
    let mn = Infinity;
    let mx = -Infinity;
    for (const [x] of pts) {
      mn = Math.min(mn, x);
      mx = Math.max(mx, x);
    }
    return mx - mn + this.voxel;
  }

  private findShoulderLine(limit: number): number {
    const H = this.height;
    for (let y = 0.75 * H; y < 0.93 * H; y += this.voxel) {
      if (this.widthAt(y, limit * 1.3) < 0.28 * (H / 1.75)) return y;
    }
    return LANDMARKS.neck * H;
  }

  private findCrotch(): number {
    const g = this.base;
    const H = this.height;
    const nxy = g.nx * g.ny;
    const iC = Math.round((0 - g.ox) / g.voxel);
    for (let y = 0.6 * H; y > 0.3 * H; y -= g.voxel) {
      const j = Math.round((y - g.oy) / g.voxel);
      let any = false;
      for (let k = 0; k < g.nz && !any; k++) {
        for (let di = -1; di <= 1; di++) if (g.data[iC + di + j * g.nx + k * nxy] < 0) any = true;
      }
      if (!any) return y;
    }
    return LANDMARKS.crotch * H;
  }

  private estimateArmAngle(): number {
    const g = this.base;
    const H = this.height;
    const jx = this.shoulderHalfWidth - 0.02;
    const jy = LANDMARKS.shoulder * H - 0.035;
    const nxy = g.nx * g.ny;
    let best = 0;
    let angle = 20;
    const j0 = Math.max(0, Math.floor((0.3 * H - g.oy) / g.voxel));
    const j1 = Math.min(g.ny - 1, Math.floor((0.86 * H - g.oy) / g.voxel));
    for (let j = j0; j <= j1; j++) {
      const y = g.oy + j * g.voxel;
      for (let k = 0; k < g.nz; k++) {
        for (let i = 0; i < g.nx; i++) {
          if (g.data[i + j * g.nx + k * nxy] >= 0) continue;
          const dx = Math.abs(g.ox + i * g.voxel) - jx;
          if (dx < 0.04) continue;
          const dy = jy - y;
          const dist = Math.hypot(dx, dy);
          if (dist > best) {
            best = dist;
            angle = (Math.atan2(dx, dy) * 180) / Math.PI;
          }
        }
      }
    }
    return Math.max(5, Math.min(85, angle));
  }
}

export class ScanCollider implements BodyModel {
  private readonly tmp = { d: 0, gx: 0, gy: 0, gz: 0 };
  constructor(readonly grid: SDFGrid, readonly height: number) {}

  collide(p: { x: number; y: number; z: number }, margin: number): boolean {
    let moved = false;
    if (p.y < margin) {
      p.y = margin;
      moved = true;
    }
    const t = this.tmp;
    if (!this.grid.sampleGrad(p.x, p.y, p.z, t)) return moved;
    if (t.d >= margin) return moved;
    const len = Math.hypot(t.gx, t.gy, t.gz);
    const push = margin - t.d;
    if (len < 1e-6) {
      p.z += push;
    } else {
      p.x += (t.gx / len) * push;
      p.y += (t.gy / len) * push;
      p.z += (t.gz / len) * push;
    }
    return true;
  }

  distance(x: number, y: number, z: number): number {
    return this.grid.sample(x, y, z);
  }
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
