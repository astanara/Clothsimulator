/**
 * Position-based-dynamics cloth built from a 2D garment pattern.
 *
 * The pattern is used twice: once as the front panel and once as the back panel. The panels share
 * particles along sewn outline points ("seams") and are separate at openings (hem, neck, cuffs...).
 * Rest lengths come from the flat pattern, so a garment that is too small ends up stretched.
 */
import type { BodyModel } from './body';
import type { Pattern } from './garment/pattern';

const THICKNESS = 0.008;
const START_BULGE = 0.16;

export interface ClothParams {
  body: BodyModel;
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
  /** Stretch the pattern sideways only (a wider cut at the same length). Default 1. */
  widthScale?: number;
  /**
   * Swing the sleeves about the shoulder joints by `deltaDeg` in the initial layout, so a flat-lay
   * garment whose sleeves point one way can be put on a body whose arms point another.
   */
  sleeveWarp?: { torsoHalf: number; jointX: number; jointY: number; deltaDeg: number };
}

export class Cloth {
  readonly pattern: Pattern;
  /** Simulation particles. */
  readonly count: number;
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  readonly pinY: Float32Array;
  private readonly ci: Int32Array;
  private readonly cj: Int32Array;
  private readonly rest: Float32Array;
  private readonly stiff: Float32Array;
  private readonly structural: Uint8Array;
  /** Render vertices: front panel then back panel, mapped onto particles. */
  readonly renderMap: Int32Array;
  /** Triangle indices: the front panel's triangles first, then the back panel's. */
  readonly indices: Uint32Array;
  /** Number of indices belonging to the front panel. */
  readonly frontIndexCount: number;
  readonly strain: Float32Array;
  /** Distance from each particle to the body surface (m). */
  readonly gap: Float32Array;

  private readonly body: BodyModel;

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

    const flatX = (i: number) => (pattern.pts[i * 2] - cx) * s * (p.widthScale ?? 1);
    const flatY = (i: number) => p.topY - (pattern.pts[i * 2 + 1] - pattern.fullBBox.minY) * s;
    const warped = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      warped[i * 2] = flatX(i);
      warped[i * 2 + 1] = flatY(i);
      if (p.sleeveWarp) {
        const { torsoHalf, jointX, jointY, deltaDeg } = p.sleeveWarp;
        const x = flatX(i);
        const sign = x < 0 ? -1 : 1;
        const t = Math.min(1, Math.max(0, (Math.abs(x) - torsoHalf * 0.9) / 0.08));
        const w = t * t * (3 - 2 * t);
        if (w > 0) {
          const u = Math.abs(x) - jointX;
          const v = flatY(i) - jointY;
          const r = Math.hypot(u, v);
          const a = Math.atan2(u, -v) + (w * deltaDeg * Math.PI) / 180;
          warped[i * 2] = sign * (jointX + r * Math.sin(a));
          warped[i * 2 + 1] = jointY - r * Math.cos(a);
        }
      }
    }
    const px = (i: number) => warped[i * 2];
    const py = (i: number) => warped[i * 2 + 1];

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
    // Resolve the initial overlap with the body. Front/back panel points are walked straight out
    // along their own side (+z / -z) so they can never end up on the wrong side of a limb;
    // seam points sit on the sides and are pushed out along the body's surface normal.
    const tmp = { x: 0, y: 0, z: 0 };
    const margin = THICKNESS * 2;
    for (let i = 0; i < N; i++) {
      for (const [k, sign] of [[front[i], 1], [back[i], -1]] as const) {
        tmp.x = this.pos[k * 3];
        tmp.y = this.pos[k * 3 + 1];
        tmp.z = this.pos[k * 3 + 2];
        if (seam[i]) {
          p.body.collide(tmp, margin);
        } else {
          for (let n = 0; n < 120 && p.body.distance(tmp.x, tmp.y, tmp.z) < margin; n++) tmp.z += sign * 0.004;
          p.body.collide(tmp, 0); // floor only
        }
        this.pos[k * 3] = tmp.x;
        this.pos[k * 3 + 1] = tmp.y;
        this.pos[k * 3 + 2] = tmp.z;
      }
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
    const flat = (a: number, b: number) => Math.hypot(flatX(a) - flatX(b), flatY(a) - flatY(b));
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
    for (let i = 0; i < N; i++) {
      this.renderMap[i] = front[i];
      this.renderMap[N + i] = back[i];
    }
    const idx: number[] = [];
    for (let t = 0; t < pattern.tris.length; t += 3) idx.push(pattern.tris[t], pattern.tris[t + 1], pattern.tris[t + 2]);
    this.frontIndexCount = idx.length;
    for (let t = 0; t < pattern.tris.length; t += 3) {
      const a = pattern.tris[t];
      const b = pattern.tris[t + 1];
      const c = pattern.tris[t + 2];
      idx.push(N + a, N + c, N + b);
    }
    this.indices = Uint32Array.from(idx);
    this.strain = new Float32Array(m).fill(1);
    this.gap = new Float32Array(m);
    this.measure();
  }

  /**
   * Start from the draped shape of a coarser cloth built from the same garment: every vertex of this
   * (finer) pattern is placed at the matching point of the coarse mesh by barycentric interpolation.
   * Converging a fine mesh from scratch is very slow; this gives it the overall drape for free.
   */
  adoptPose(coarse: Cloth) {
    const hp = this.pattern;
    const cp = coarse.pattern;
    const Nh = hp.pts.length / 2;
    const Nc = cp.pts.length / 2;
    const cu = (i: number) => cp.pts[i * 2] / cp.w;
    const cv = (i: number) => cp.pts[i * 2 + 1] / cp.h;
    const T = cp.tris.length / 3;
    const bb = new Float32Array(T * 4);
    for (let t = 0; t < T; t++) {
      const a = cp.tris[t * 3], b = cp.tris[t * 3 + 1], c = cp.tris[t * 3 + 2];
      bb[t * 4] = Math.min(cu(a), cu(b), cu(c));
      bb[t * 4 + 1] = Math.max(cu(a), cu(b), cu(c));
      bb[t * 4 + 2] = Math.min(cv(a), cv(b), cv(c));
      bb[t * 4 + 3] = Math.max(cv(a), cv(b), cv(c));
    }
    const margin = 0.03;
    for (let i = 0; i < Nh; i++) {
      const u = hp.pts[i * 2] / hp.w;
      const v = hp.pts[i * 2 + 1] / hp.h;
      let bestT = -1;
      let bestMin = -Infinity;
      let bw: [number, number, number] = [1, 0, 0];
      for (let t = 0; t < T; t++) {
        if (u < bb[t * 4] - margin || u > bb[t * 4 + 1] + margin || v < bb[t * 4 + 2] - margin || v > bb[t * 4 + 3] + margin) continue;
        const a = cp.tris[t * 3], b = cp.tris[t * 3 + 1], c = cp.tris[t * 3 + 2];
        const d = (cv(b) - cv(c)) * (cu(a) - cu(c)) + (cu(c) - cu(b)) * (cv(a) - cv(c));
        if (Math.abs(d) < 1e-12) continue;
        const w0 = ((cv(b) - cv(c)) * (u - cu(c)) + (cu(c) - cu(b)) * (v - cv(c))) / d;
        const w1 = ((cv(c) - cv(a)) * (u - cu(c)) + (cu(a) - cu(c)) * (v - cv(c))) / d;
        const w2 = 1 - w0 - w1;
        const m = Math.min(w0, w1, w2);
        if (m > bestMin) {
          bestMin = m;
          bestT = t;
          bw = [w0, w1, w2];
          if (m >= 0) break;
        }
      }
      if (bestT < 0) continue;
      let [w0, w1, w2] = bw;
      w0 = Math.max(0, w0);
      w1 = Math.max(0, w1);
      w2 = Math.max(0, w2);
      const sum = w0 + w1 + w2 || 1;
      w0 /= sum;
      w1 /= sum;
      w2 /= sum;
      const tri = [cp.tris[bestT * 3], cp.tris[bestT * 3 + 1], cp.tris[bestT * 3 + 2]];
      for (const panel of [0, 1]) {
        const cOff = panel ? Nc : 0;
        const k = this.renderMap[(panel ? Nh : 0) + i] * 3;
        const p0 = coarse.renderMap[cOff + tri[0]] * 3;
        const p1 = coarse.renderMap[cOff + tri[1]] * 3;
        const p2 = coarse.renderMap[cOff + tri[2]] * 3;
        for (let c = 0; c < 3; c++) this.pos[k + c] = w0 * coarse.pos[p0 + c] + w1 * coarse.pos[p1 + c] + w2 * coarse.pos[p2 + c];
      }
    }
    this.prev.set(this.pos);
    this.measure();
  }

  /** Multiplier on gravity (the high quality pass uses a light touch so the coarse drape is kept). */
  gravityScale = 1;
  /** Treat structural edges as fully stiff regardless of the fabric's stretchiness. */
  fullStiffness = false;
  private relaxing = false;

  /**
   * Settle without gravity: lets the constraints pull a garment that has stretched under its own
   * weight back to its true length (long hanging garments, fine meshes).
   */
  relax(iterations = 120) {
    const g0 = this.gravityScale;
    this.gravityScale = 0;
    this.relaxing = true; // structural edges at full stiffness so the true length is restored
    this.prev.set(this.pos);
    this.step(1 / 60, iterations);
    this.relaxing = false;
    this.gravityScale = g0;
  }

  step(dt = 1 / 60, iterations = 16) {
    const { pos, prev, pinY } = this;
    const g = -9.8 * dt * dt * this.gravityScale;
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
      if (!Number.isNaN(pinY[i]) && pos[k + 1] < pinY[i]) {
        pos[k + 1] = pinY[i];
        prev[k + 1] = pinY[i];
      }
    }
    const { ci, cj, rest, stiff } = this;
    const tmp = { x: 0, y: 0, z: 0 };
    for (let it = 0; it < iterations; it++) {
      // sweep the constraints forwards then backwards on alternate iterations so corrections
      // travel along long hanging garments faster
      const nC = ci.length;
      for (let q = 0; q < nC; q++) {
        const c = it & 1 ? nC - 1 - q : q;
        const a = ci[c] * 3;
        const b = cj[c] * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const f = ((len - rest[c]) / len) * ((this.relaxing || this.fullStiffness) && this.structural[c] ? 1 : stiff[c]) * 0.5;
        pos[a] += dx * f;
        pos[a + 1] += dy * f;
        pos[a + 2] += dz * f;
        pos[b] -= dx * f;
        pos[b + 1] -= dy * f;
        pos[b + 2] -= dz * f;
      }
      for (let i = 0; i < this.count; i++) {
        const k = i * 3;
        // held edges may rest higher (on the shoulders) but not sag below their line
        if (!Number.isNaN(pinY[i]) && pos[k + 1] < pinY[i]) pos[k + 1] = pinY[i];
        tmp.x = pos[k];
        tmp.y = pos[k + 1];
        tmp.z = pos[k + 2];
        const x0 = tmp.x;
        const y0 = tmp.y;
        const z0 = tmp.z;
        if (this.body.collide(tmp, THICKNESS)) {
          pos[k] = tmp.x;
          pos[k + 1] = tmp.y;
          pos[k + 2] = tmp.z;
          // Static friction: against the contact normal, cancel the sideways motion of this step
          // (gravity creep) up to a limit that grows with how hard the cloth is pressed on the body.
          const cx = tmp.x - x0;
          const cy = tmp.y - y0;
          const cz = tmp.z - z0;
          const cl = Math.hypot(cx, cy, cz);
          if (cl > 1e-7 && !this.relaxing) {
            const nx = cx / cl, ny = cy / cl, nz = cz / cl;
            const dx = pos[k] - prev[k], dy = pos[k + 1] - prev[k + 1], dz = pos[k + 2] - prev[k + 2];
            const dn = dx * nx + dy * ny + dz * nz;
            const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz;
            const tl = Math.hypot(tx, ty, tz);
            if (tl > 1e-9) {
              const f = Math.min(1, (0.004 + 0.8 * cl) / tl);
              pos[k] -= tx * f;
              pos[k + 1] -= ty * f;
              pos[k + 2] -= tz * f;
            }
          }
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
export function anchorToY(body: BodyModel, anchor: number, offsetCm: number): number {
  return anchor * body.height + offsetCm / 100;
}
