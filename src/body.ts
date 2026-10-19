/**
 * Parametric body (units: metres, +y up, facing +z).
 * Torso is a stack of elliptical cross-sections; head, arms and legs are capsules.
 */

export interface BodyMeasurements {
  /** All in cm. */
  height: number;
  chest: number;
  waist: number;
  hip: number;
  shoulderWidth: number;
}

export const DEFAULT_BODY: BodyMeasurements = {
  height: 175,
  chest: 98,
  waist: 82,
  hip: 100,
  shoulderWidth: 44,
};

export interface Section {
  y: number;
  /** Half-width (x) and half-depth (z) of the ellipse. */
  a: number;
  b: number;
}

/** Tapered capsule: radius ra at point a, rb at point b. */
export interface Capsule {
  a: [number, number, number];
  b: [number, number, number];
  ra: number;
  rb: number;
}

/** Ramanujan perimeter of an ellipse. */
export function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Ellipse semi-axes for a circumference and depth/width ratio. */
export function ellipseFromCircumference(c: number, depthRatio: number): { a: number; b: number } {
  const a = c / ellipsePerimeter(1, depthRatio);
  return { a, b: a * depthRatio };
}

/** Height fractions (of body height) of the landmarks used by the model. */
export const LANDMARKS = {
  crotch: 0.47,
  hip: 0.52,
  waist: 0.62,
  chest: 0.72,
  shoulder: 0.82,
  neck: 0.86,
};

export class Body {
  readonly sections: Section[];
  readonly capsules: Capsule[] = [];
  readonly height: number;
  readonly yMin: number;
  readonly yMax: number;

  /** Lowest height drawn for the torso (collision may extend lower, see `fillCrotch`). */
  readonly visibleYMin: number;

  /**
   * @param armAngle degrees from vertical (0 = arms down, 90 = T-pose).
   * @param fillCrotch add an invisible pelvis block between the legs so skirts, dresses and
   *   long tops hang from the hips instead of sagging into the gap between the legs.
   */
  constructor(readonly m: BodyMeasurements, readonly armAngle = 30, fillCrotch = false) {
    this.height = m.height / 100;
    const H = this.height;
    const cm = (v: number) => v / 100;
    // [height fraction, circumference (m), depth/width ratio]
    const shoulderC = Math.max(cm(m.shoulderWidth) * 2.2, cm(m.chest) * 0.95);
    const keys: [number, number, number][] = [
      ...(fillCrotch
        ? ([
            [0.3, cm(m.hip) * 0.78, 0.8],
            [0.38, cm(m.hip) * 0.88, 0.78],
          ] as [number, number, number][])
        : []),
      [LANDMARKS.crotch, cm(m.hip), 0.75],
      [LANDMARKS.hip, cm(m.hip), 0.75],
      [LANDMARKS.waist, cm(m.waist), 0.72],
      [LANDMARKS.chest, cm(m.chest), 0.72],
      [LANDMARKS.shoulder, shoulderC, 0.55],
      [LANDMARKS.neck, 0.36, 0.9],
      [LANDMARKS.neck + 0.03, 0.34, 0.9],
    ];
    const N = 80;
    this.visibleYMin = LANDMARKS.crotch * H;
    this.yMin = keys[0][0] * H;
    this.yMax = keys[keys.length - 1][0] * H;
    this.sections = [];
    for (let i = 0; i < N; i++) {
      const f = keys[0][0] + ((keys[keys.length - 1][0] - keys[0][0]) * i) / (N - 1);
      let k = 0;
      while (k < keys.length - 2 && f > keys[k + 1][0]) k++;
      const t = smooth((f - keys[k][0]) / (keys[k + 1][0] - keys[k][0]));
      const c = lerp(keys[k][1], keys[k + 1][1], t);
      const r = lerp(keys[k][2], keys[k + 1][2], t);
      const { a, b } = ellipseFromCircumference(c, r);
      this.sections.push({ y: f * H, a, b });
    }
    this.buildLimbs();
  }

  private buildLimbs() {
    const H = this.height;
    const hip = this.sectionAt(this.visibleYMin);
    const sh = this.sectionAt(LANDMARKS.shoulder * H);
    // Legs: slightly splayed so trousers have a gap between them.
    const r0 = hip.a * 0.52;
    for (const s of [-1, 1]) {
      this.capsules.push({
        a: [s * hip.a * 0.5, this.yMin + 0.02, 0],
        b: [s * (hip.a * 0.5 + 0.03), 0.045, 0.0],
        ra: r0,
        rb: 0.04,
      });
    }
    // Arms
    const th = (this.armAngle * Math.PI) / 180;
    const L = 0.33 * H;
    const jy = LANDMARKS.shoulder * H - 0.035;
    for (const s of [-1, 1]) {
      const jx = s * (sh.a - 0.02);
      this.capsules.push({
        a: [jx, jy, 0],
        b: [jx + s * Math.sin(th) * L, jy - Math.cos(th) * L, 0],
        ra: 0.05,
        rb: 0.032,
      });
    }
    // Head
    this.capsules.push({
      a: [0, H * 0.935, 0],
      b: [0, H * 0.935, 0],
      ra: 0.1,
      rb: 0.1,
    });
  }

  /** Interpolated ellipse at height y (clamped to body range). */
  sectionAt(y: number): Section {
    const s = this.sections;
    const t = ((y - this.yMin) / (this.yMax - this.yMin)) * (s.length - 1);
    const i = Math.max(0, Math.min(s.length - 2, Math.floor(t)));
    const u = Math.max(0, Math.min(1, t - i));
    return { y, a: lerp(s[i].a, s[i + 1].a, u), b: lerp(s[i].b, s[i + 1].b, u) };
  }

  /** Circumference of the torso at a height fraction. */
  circumferenceAt(frac: number): number {
    const s = this.sectionAt(frac * this.height);
    return ellipsePerimeter(s.a, s.b);
  }

  /**
   * Push a point out of the body and above the floor. Returns true if it was moved.
   * `margin` is the cloth thickness in metres.
   */
  collide(p: { x: number; y: number; z: number }, margin: number): boolean {
    let moved = false;
    if (p.y < margin) {
      p.y = margin;
      moved = true;
    }
    if (p.y >= this.yMin && p.y <= this.yMax) {
      const s = this.sectionAt(p.y);
      const a = s.a + margin;
      const b = s.b + margin;
      const f = (p.x * p.x) / (a * a) + (p.z * p.z) / (b * b);
      if (f < 1) {
        if (f < 1e-9) {
          p.z = b;
        } else {
          const k = 1 / Math.sqrt(f);
          p.x *= k;
          p.z *= k;
        }
        moved = true;
      }
    }
    for (const c of this.capsules) {
      if (collideCapsule(p, c, margin)) moved = true;
    }
    return moved;
  }

  /** Approximate distance from a point to the body surface (negative = inside). */
  distance(x: number, y: number, z: number): number {
    let d = Infinity;
    if (y >= this.yMin && y <= this.yMax) {
      const s = this.sectionAt(y);
      const k = Math.sqrt((x * x) / (s.a * s.a) + (z * z) / (s.b * s.b));
      d = Math.hypot(x, z) * (1 - 1 / Math.max(k, 1e-6));
    } else {
      const s = this.sectionAt(Math.min(Math.max(y, this.yMin), this.yMax));
      const k = Math.sqrt((x * x) / (s.a * s.a) + (z * z) / (s.b * s.b));
      const dy = y < this.yMin ? this.yMin - y : y - this.yMax;
      d = Math.hypot(dy, k > 1 ? Math.hypot(x, z) * (1 - 1 / k) : 0);
    }
    for (const c of this.capsules) {
      const [t, cx, cy, cz] = closestOnCapsule(x, y, z, c);
      d = Math.min(d, Math.hypot(x - cx, y - cy, z - cz) - (c.ra + (c.rb - c.ra) * t));
    }
    return d;
  }
}

function closestOnCapsule(x: number, y: number, z: number, c: Capsule): [number, number, number, number] {
  const abx = c.b[0] - c.a[0];
  const aby = c.b[1] - c.a[1];
  const abz = c.b[2] - c.a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((x - c.a[0]) * abx + (y - c.a[1]) * aby + (z - c.a[2]) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [t, c.a[0] + abx * t, c.a[1] + aby * t, c.a[2] + abz * t];
}

function collideCapsule(p: { x: number; y: number; z: number }, c: Capsule, margin: number): boolean {
  const [t, cx, cy, cz] = closestOnCapsule(p.x, p.y, p.z, c);
  const r = c.ra + (c.rb - c.ra) * t + margin;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  if (d < 1e-9) {
    p.z = cz + r;
  } else {
    const k = r / d;
    p.x = cx + dx * k;
    p.y = cy + dy * k;
    p.z = cz + dz * k;
  }
  return true;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function smooth(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
