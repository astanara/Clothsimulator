/**
 * Position-based-dynamics cloth built from a 2D garment pattern.
 *
 * The pattern is used twice: once as the front panel and once as the back panel. The panels share
 * particles along sewn outline points ("seams") and are separate at openings (hem, neck, cuffs...).
 * Rest lengths come from the flat pattern, so a garment that is too small ends up stretched.
 */
import type { Body } from './body';
import type { Pattern } from './garment/pattern';

const THICKNESS = 0.008;
const START_BULGE = 0.16;

export interface ClothParams {
  body: Body;
  pattern: Pattern;
  /** 1 = open (hem, neck, ...), per pattern.boundary entry. */
  openings: Uint8Array;
  metersPerPx: number;
  /** World height of the top edge of the garment. */
  topY: number;
  holdTop: boolean;
  /** Edge stiffness 0..1 (lower = stretchier). */
  stiffness: number;
  /** Resistance to sharp folds 0..1. */
  bend: number;
}

export class Cloth {
  readonly pattern: Pattern;
  /** Simulation particles. */
  readonly count: number;
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly pinY: Float32Array;
  private readonly ci: Int32Array;
  private readonly cj: Int32Array;
  private readonly rest: Float32Array;
  private readonly stiff: Float32Array;
  private readonly structural: Uint8Array;
  /** Render vertices: front panel then back panel, mapped onto particles. */
  readonly renderMap: Int32Array;
  readonly uv: Float32Array;
  readonly indices: Uint32Array;
  readonly strain: Float32Array;
  /** Distance from each particle to the body surface (m). */
  readonly gap: Float32Array;

  private readonly body: Body;

  constructor(p: ClothParams) {
    this.body = p.body;
    this.pattern = p.pattern;
    const { pattern, openings, metersPerPx: s } = p;
    const N = pattern.pts.length / 2;
    const cx = (pattern.bbox.minX + pattern.bbox.maxX) / 2;

    // Which pattern points are sewn (front and back share a particle).
    const seam = new Uint8Array(N);
    pattern.boundary.forEach((pi, k) => {
      if (!openings[k]) seam[pi] = 1;
    });
    const front = new Int32Array(N);
    const back = new Int32Array(N);
    let m = 0;
    for (let i = 0; i < N; i++) front[i] = m++;
    for (let i = 0; i < N; i++) back[i] = seam[i] ? front[i] : m++;
    this.count = m;

    const px = (i: number) => (pattern.pts[i * 2] - cx) * s;
    const py = (i: number) => p.topY - (pattern.pts[i * 2 + 1] - pattern.bbox.minY) * s;

    // Start shape: sheets bulging away from the seams so nothing begins inside the body.
    const seamIdx: number[] = [];
    for (let i = 0; i < N; i++) if (seam[i]) seamIdx.push(i);
    this.pos = new Float32Array(m * 3);
    for (let i = 0; i < N; i++) {
      let d = Infinity;
      if (seam[i]) d = 0;
      else
        for (const j of seamIdx) d = Math.min(d, Math.hypot(px(i) - px(j), py(i) - py(j)));
      const z = Number.isFinite(d) ? Math.min(START_BULGE, 1.2 * d) : START_BULGE;
      for (const [k, sign] of [[front[i], 1], [back[i], -1]] as const) {
        this.pos[k * 3] = px(i);
        this.pos[k * 3 + 1] = py(i);
        this.pos[k * 3 + 2] = sign * z;
      }
    }
    const tmp = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < m; k++) {
      tmp.x = this.pos[k * 3];
      tmp.y = this.pos[k * 3 + 1];
      tmp.z = this.pos[k * 3 + 2];
      p.body.collide(tmp, THICKNESS * 2);
      this.pos[k * 3] = tmp.x;
      this.pos[k * 3 + 1] = tmp.y;
      this.pos[k * 3 + 2] = tmp.z;
    }
    this.prev = Float32Array.from(this.pos);

    // Hold the waist edge's height (trousers, skirts).
    this.pinY = new Float32Array(m).fill(NaN);
    if (p.holdTop) {
      const H = pattern.bbox.maxY - pattern.bbox.minY;
      pattern.boundary.forEach((pi) => {
        if (pattern.pts[pi * 2 + 1] - pattern.bbox.minY < H * 0.05) {
          this.pinY[front[pi]] = this.pos[front[pi] * 3 + 1];
          this.pinY[back[pi]] = this.pos[back[pi] * 3 + 1];
        }
      });
    }

    // Constraints: every triangle edge (stretch/shear) and across-edge pairs (bend), per panel.
    const ci: number[] = [];
    const cj: number[] = [];
    const rest: number[] = [];
    const stiff: number[] = [];
    const structural: number[] = [];
    const seen = new Set<number>();
    const addC = (a: number, b: number, r: number, k: number, st: number) => {
      const key = Math.min(a, b) * m + Math.max(a, b);
      if (seen.has(key)) return;
      seen.add(key);
      ci.push(a);
      cj.push(b);
      rest.push(r);
      stiff.push(k);
      structural.push(st);
    };
    const flat = (a: number, b: number) => Math.hypot(px(a) - px(b), py(a) - py(b));
    for (const panel of [front, back]) {
      const opp = new Map<number, number[]>();
      for (let t = 0; t < pattern.tris.length; t += 3) {
        const v = [pattern.tris[t], pattern.tris[t + 1], pattern.tris[t + 2]];
        for (let e = 0; e < 3; e++) {
          const a = v[e];
          const b = v[(e + 1) % 3];
          const c = v[(e + 2) % 3];
          addC(panel[a], panel[b], flat(a, b), p.stiffness, 1);
          const key = Math.min(a, b) * N + Math.max(a, b);
          const list = opp.get(key);
          if (list) list.push(c);
          else opp.set(key, [c]);
        }
      }
      for (const list of opp.values()) {
        if (list.length === 2) addC(panel[list[0]], panel[list[1]], flat(list[0], list[1]), p.bend, 0);
      }
    }
    this.ci = Int32Array.from(ci);
    this.cj = Int32Array.from(cj);
    this.rest = Float32Array.from(rest);
    this.stiff = Float32Array.from(stiff);
    this.structural = Uint8Array.from(structural);

    // Render mesh (front + back copies so each panel can carry its own UVs / normals).
    this.renderMap = new Int32Array(N * 2);
    this.uv = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      this.renderMap[i] = front[i];
      this.renderMap[N + i] = back[i];
      const u = pattern.pts[i * 2] / pattern.w;
      const v = 1 - pattern.pts[i * 2 + 1] / pattern.h;
      this.uv.set([u, v], i * 2);
      this.uv.set([u, v], (N + i) * 2);
    }
    const idx: number[] = [];
    for (let t = 0; t < pattern.tris.length; t += 3) {
      const a = pattern.tris[t];
      const b = pattern.tris[t + 1];
      const c = pattern.tris[t + 2];
      idx.push(a, b, c, N + a, N + c, N + b);
    }
    this.indices = Uint32Array.from(idx);
    this.strain = new Float32Array(m).fill(1);
    this.gap = new Float32Array(m);
    this.measure();
  }

  step(dt = 1 / 60, iterations = 10) {
    const { pos, prev, pinY } = this;
    const g = -9.8 * dt * dt;
    const maxMove = 0.02;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      for (let c = 0; c < 3; c++) {
        let v = (pos[k + c] - prev[k + c]) * 0.985;
        if (v > maxMove) v = maxMove;
        else if (v < -maxMove) v = -maxMove;
        prev[k + c] = pos[k + c];
        pos[k + c] += v + (c === 1 ? g : 0);
      }
      if (!Number.isNaN(pinY[i])) {
        pos[k + 1] = pinY[i];
        prev[k + 1] = pinY[i];
      }
    }
    const { ci, cj, rest, stiff } = this;
    const tmp = { x: 0, y: 0, z: 0 };
    for (let it = 0; it < iterations; it++) {
      for (let c = 0; c < ci.length; c++) {
        const a = ci[c] * 3;
        const b = cj[c] * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const f = ((len - rest[c]) / len) * stiff[c] * 0.5;
        pos[a] += dx * f;
        pos[a + 1] += dy * f;
        pos[a + 2] += dz * f;
        pos[b] -= dx * f;
        pos[b + 1] -= dy * f;
        pos[b + 2] -= dz * f;
      }
      for (let i = 0; i < this.count; i++) {
        const k = i * 3;
        if (!Number.isNaN(pinY[i])) pos[k + 1] = pinY[i];
        tmp.x = pos[k];
        tmp.y = pos[k + 1];
        tmp.z = pos[k + 2];
        if (this.body.collide(tmp, THICKNESS)) {
          // contact friction: drag the previous position toward the new one
          pos[k] = tmp.x;
          pos[k + 1] = tmp.y;
          pos[k + 2] = tmp.z;
          for (let c = 0; c < 3; c++) prev[k + c] += (pos[k + c] - prev[k + c]) * 0.6;
        }
      }
    }
    this.measure();
  }

  /** Update per-particle strain (stretch ratio) and distance to the body. */
  measure() {
    const { pos } = this;
    const sum = new Float32Array(this.count);
    const cnt = new Uint8Array(this.count);
    for (let c = 0; c < this.ci.length; c++) {
      if (!this.structural[c]) continue;
      const a = this.ci[c] * 3;
      const b = this.cj[c] * 3;
      const r = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]) / this.rest[c];
      sum[this.ci[c]] += r;
      sum[this.cj[c]] += r;
      cnt[this.ci[c]]++;
      cnt[this.cj[c]]++;
    }
    for (let i = 0; i < this.count; i++) {
      this.strain[i] = cnt[i] ? sum[i] / cnt[i] : 1;
      this.gap[i] = this.body.distance(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
  }

  settle(steps = 300) {
    for (let s = 0; s < steps; s++) this.step();
  }
}

/** World y of the garment's top edge for a preset anchor. */
export function anchorToY(body: Body, anchor: number, offsetCm: number): number {
  return anchor * body.height + offsetCm / 100;
}
