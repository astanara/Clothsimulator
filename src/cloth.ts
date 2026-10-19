/**
 * Position-based-dynamics cloth for a tube garment (sleeveless top) draped on a Body.
 * Units: metres. The garment pattern defines rest lengths; the cloth starts oversized
 * around the body and the constraints pull it in, so tight garments end up stretched.
 */
import { Body, LANDMARKS, ellipseFromCircumference, ellipsePerimeter } from './body';
import type { Garment } from './fit';

export const RINGS = 56;
export const ROWS = 30;
const THICKNESS = 0.004;

interface Constraint {
  i: number;
  j: number;
  rest: number;
  stiff: number;
}

export class Cloth {
  readonly count = RINGS * ROWS;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly pinned: boolean[];
  readonly pinTarget: Float32Array;
  readonly constraints: Constraint[] = [];
  readonly indices: number[] = [];
  private readonly hRest: number[] = [];
  /** Per-vertex stretch ratio (>1 = stretched, i.e. cloth is pulled tight). */
  readonly strain: Float32Array;
  /** Per-vertex normalised distance from the body surface (1 = touching). */
  readonly gap: Float32Array;

  constructor(readonly body: Body, readonly garment: Garment) {
    const n = this.count;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.pinned = new Array(n).fill(false);
    this.pinTarget = new Float32Array(n * 3);
    this.strain = new Float32Array(n).fill(1);
    this.gap = new Float32Array(n).fill(1);
    this.build();
  }

  idx(ring: number, row: number) {
    return row * RINGS + ((ring + RINGS) % RINGS);
  }

  private build() {
    const { body, garment: g } = this;
    const H = body.height;
    const yTop = LANDMARKS.shoulder * H;
    const yBot = yTop - g.length / 100;
    const ratio = (y: number) => {
      const s = body.sectionAt(y);
      return s.b / s.a;
    };

    for (let row = 0; row < ROWS; row++) {
      const t = row / (ROWS - 1); // 0 = hem, 1 = top
      const y = yBot + t * (yTop - yBot);
      // Garment circumference profile: hem -> waist -> chest
      const yFrac = y / H;
      const gc = this.garmentCircumference(yFrac) / 100;
      const bs = body.sectionAt(Math.min(Math.max(y, body.yMin), body.yMax));
      const bodyC = ellipsePerimeter(bs.a, bs.b);
      // Start slightly outside both body and garment so nothing begins inside the body.
      const startC = Math.max(gc, bodyC * 1.04);
      const e = ellipseFromCircumference(startC, ratio(y));
      for (let r = 0; r < RINGS; r++) {
        const ang = (r / RINGS) * Math.PI * 2;
        const k = this.idx(r, row) * 3;
        this.pos[k] = Math.sin(ang) * e.a;
        this.pos[k + 1] = y;
        this.pos[k + 2] = Math.cos(ang) * e.b;
      }
      // Rest length of horizontal edges comes from the garment's flat pattern.
      this.hRest[row] = gc / RINGS;
      for (let r = 0; r < RINGS; r++) {
        const rest = gc / RINGS;
        this.add(this.idx(r, row), this.idx(r + 1, row), rest, 1);
        this.add(this.idx(r, row), this.idx(r + 2, row), rest * 2 * 0.99, 0.15);
      }
    }
    const vRest = g.length / 100 / (ROWS - 1);
    for (let row = 0; row < ROWS - 1; row++) {
      for (let r = 0; r < RINGS; r++) {
        this.add(this.idx(r, row), this.idx(r, row + 1), vRest, 1);
        // shear
        this.add(this.idx(r, row), this.idx(r + 1, row + 1), Math.hypot(vRest, this.restH(row)), 0.6);
        this.add(this.idx(r + 1, row), this.idx(r, row + 1), Math.hypot(vRest, this.restH(row)), 0.6);
      }
    }
    for (let row = 0; row < ROWS - 2; row++) {
      for (let r = 0; r < RINGS; r++) this.add(this.idx(r, row), this.idx(r, row + 2), vRest * 2, 0.15);
    }
    // Triangles
    for (let row = 0; row < ROWS - 1; row++) {
      for (let r = 0; r < RINGS; r++) {
        const a = this.idx(r, row);
        const b = this.idx(r + 1, row);
        const c = this.idx(r, row + 1);
        const d = this.idx(r + 1, row + 1);
        this.indices.push(a, b, c, b, d, c);
      }
    }
    // Pin the top ring at the shoulder line (like straps holding the garment up).
    for (let r = 0; r < RINGS; r++) {
      const i = this.idx(r, ROWS - 1);
      this.pinned[i] = true;
      for (let c = 0; c < 3; c++) this.pinTarget[i * 3 + c] = this.pos[i * 3 + c];
    }
    this.prev.set(this.pos);
  }

  private restH(row: number) {
    return this.hRest[row];
  }

  /** Garment circumference (cm) at a body-height fraction. */
  private garmentCircumference(yFrac: number): number {
    const g = this.garment;
    const t = (yFrac - (LANDMARKS.shoulder - g.length / 100 / this.body.height)) /
      (g.length / 100 / this.body.height);
    // t=0 hem, t=1 shoulder
    const stops: [number, number][] = [
      [0, g.hem],
      [0.35, g.waist],
      [0.8, g.chest],
      [1, g.chest],
    ];
    const tt = Math.min(Math.max(t, 0), 1);
    for (let k = 0; k < stops.length - 1; k++) {
      if (tt <= stops[k + 1][0]) {
        const u = (tt - stops[k][0]) / (stops[k + 1][0] - stops[k][0]);
        return stops[k][1] + (stops[k + 1][1] - stops[k][1]) * u;
      }
    }
    return g.chest;
  }

  private add(i: number, j: number, rest: number, stiff: number) {
    this.constraints.push({ i, j, rest, stiff });
  }

  step(dt = 1 / 60, iterations = 12) {
    const { pos, prev, pinned, pinTarget } = this;
    const damping = 0.985;
    const gravity = -9.8 * dt * dt;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      if (pinned[i]) {
        for (let c = 0; c < 3; c++) {
          pos[k + c] = pinTarget[k + c];
          prev[k + c] = pinTarget[k + c];
        }
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = (pos[k + c] - prev[k + c]) * damping;
        prev[k + c] = pos[k + c];
        pos[k + c] += v + (c === 1 ? gravity : 0);
      }
    }
    const tmp = { x: 0, y: 0, z: 0 };
    for (let it = 0; it < iterations; it++) {
      for (const c of this.constraints) {
        const a = c.i * 3;
        const b = c.j * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const diff = ((len - c.rest) / len) * c.stiff;
        const wa = this.pinned[c.i] ? 0 : 1;
        const wb = this.pinned[c.j] ? 0 : 1;
        const w = wa + wb;
        if (w === 0) continue;
        const sa = (diff * wa) / w;
        const sb = (diff * wb) / w;
        pos[a] += dx * sa;
        pos[a + 1] += dy * sa;
        pos[a + 2] += dz * sa;
        pos[b] -= dx * sb;
        pos[b + 1] -= dy * sb;
        pos[b + 2] -= dz * sb;
      }
      this.collide(tmp);
    }
    this.measure();
  }

  private collide(tmp: { x: number; y: number; z: number }) {
    const { pos, prev } = this;
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue;
      const k = i * 3;
      tmp.x = pos[k];
      tmp.y = pos[k + 1];
      tmp.z = pos[k + 2];
      if (this.body.collide(tmp, THICKNESS)) {
        // friction: damp tangential motion on contact
        const f = 0.3;
        pos[k] = tmp.x;
        pos[k + 2] = tmp.z;
        prev[k] += (pos[k] - prev[k]) * f;
        prev[k + 1] += (pos[k + 1] - prev[k + 1]) * f;
        prev[k + 2] += (pos[k + 2] - prev[k + 2]) * f;
      }
    }
  }

  /** Update per-vertex strain and body gap used for the fit heatmap. */
  measure() {
    const { pos } = this;
    const sum = new Float32Array(this.count);
    const cnt = new Uint8Array(this.count);
    for (const c of this.constraints) {
      if (c.stiff < 0.9) continue; // only structural edges
      const a = c.i * 3;
      const b = c.j * 3;
      const len = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
      const ratio = len / c.rest;
      sum[c.i] += ratio;
      sum[c.j] += ratio;
      cnt[c.i]++;
      cnt[c.j]++;
    }
    for (let i = 0; i < this.count; i++) {
      this.strain[i] = cnt[i] ? sum[i] / cnt[i] : 1;
      this.gap[i] = this.body.radialRatio(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
  }

  /** Run until the cloth settles (used by tests and the Simulate button). */
  settle(maxSteps = 400) {
    for (let s = 0; s < maxSteps; s++) this.step();
  }
}
