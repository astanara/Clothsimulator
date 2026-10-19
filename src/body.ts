/** Parametric body: a stack of elliptical cross-sections (units: metres). */

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
  readonly height: number;
  readonly yMin: number;
  readonly yMax: number;

  constructor(readonly m: BodyMeasurements) {
    this.height = m.height / 100;
    const H = this.height;
    const cm = (v: number) => v / 100;
    // [height fraction, circumference (m), depth/width ratio]
    const shoulderC = Math.max(cm(m.shoulderWidth) * 2.2, cm(m.chest) * 0.95);
    const keys: [number, number, number][] = [
      [LANDMARKS.crotch - 0.08, cm(m.hip) * 1.0, 0.75],
      [LANDMARKS.crotch, cm(m.hip) * 1.0, 0.75],
      [LANDMARKS.hip, cm(m.hip), 0.75],
      [LANDMARKS.waist, cm(m.waist), 0.72],
      [LANDMARKS.chest, cm(m.chest), 0.72],
      [LANDMARKS.shoulder, shoulderC, 0.55],
      [LANDMARKS.neck, 0.36, 0.9],
      [LANDMARKS.neck + 0.03, 0.34, 0.9],
    ];
    const N = 80;
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
  }

  /** Interpolated ellipse at height y (clamped to body range). */
  sectionAt(y: number): Section {
    const s = this.sections;
    const t = ((y - this.yMin) / (this.yMax - this.yMin)) * (s.length - 1);
    const i = Math.max(0, Math.min(s.length - 2, Math.floor(t)));
    const u = Math.max(0, Math.min(1, t - i));
    return { y, a: lerp(s[i].a, s[i + 1].a, u), b: lerp(s[i].b, s[i + 1].b, u) };
  }

  /** Circumference of the body at a height fraction. */
  circumferenceAt(frac: number): number {
    const s = this.sectionAt(frac * this.height);
    return ellipsePerimeter(s.a, s.b);
  }

  /**
   * Push a point out of the body. Returns true if it was moved.
   * `margin` is the cloth thickness in metres.
   */
  collide(p: { x: number; y: number; z: number }, margin: number): boolean {
    if (p.y < this.yMin || p.y > this.yMax) return false;
    const s = this.sectionAt(p.y);
    const a = s.a + margin;
    const b = s.b + margin;
    const f = (p.x * p.x) / (a * a) + (p.z * p.z) / (b * b);
    if (f >= 1) return false;
    if (f < 1e-9) {
      p.z = b;
      return true;
    }
    const k = 1 / Math.sqrt(f);
    p.x *= k;
    p.z *= k;
    return true;
  }

  /** Normalised radial distance from the body surface: <1 inside, 1 at surface. */
  radialRatio(x: number, y: number, z: number): number {
    const s = this.sectionAt(y);
    return Math.sqrt((x * x) / (s.a * s.a) + (z * z) / (s.b * s.b));
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function smooth(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
