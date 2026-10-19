/**
 * Signed distance field of a triangle mesh on a voxel grid, used for collision against body scans.
 *
 * 1. Rasterise the triangles into surface voxels.
 * 2. Flood-fill the outside from the grid border; everything else is "inside".
 *    (Meshes with holes leak: the inside is then just a thin shell, which still collides correctly.)
 * 3. Exact Euclidean distance transform from the boundary voxels of the inside.
 */

export interface SDFOptions {
  voxel: number;
  /**
   * Fill the gap between the legs (rows between y0 and y1) so skirts/dresses hang from the hips
   * instead of sagging between the thighs.
   */
  fillGap?: { y0: number; y1: number; maxGap: number };
}

export class SDFGrid {
  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly nz: number,
    readonly ox: number,
    readonly oy: number,
    readonly oz: number,
    readonly voxel: number,
    readonly data: Float32Array,
  ) {}

  /** Distance at a point (trilinear); large positive outside the grid. */
  sample(x: number, y: number, z: number): number {
    const g = this.cell(x, y, z);
    if (!g) return 0.5;
    const { i, j, k, fx, fy, fz } = g;
    const d = this.data;
    const nx = this.nx;
    const nxy = this.nx * this.ny;
    const b = i + j * nx + k * nxy;
    const c00 = d[b] * (1 - fx) + d[b + 1] * fx;
    const c10 = d[b + nx] * (1 - fx) + d[b + nx + 1] * fx;
    const c01 = d[b + nxy] * (1 - fx) + d[b + nxy + 1] * fx;
    const c11 = d[b + nxy + nx] * (1 - fx) + d[b + nxy + nx + 1] * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }

  /** Distance and (unnormalised) gradient; returns false when outside the grid. */
  sampleGrad(x: number, y: number, z: number, out: { d: number; gx: number; gy: number; gz: number }): boolean {
    const g = this.cell(x, y, z);
    if (!g) return false;
    const { i, j, k, fx, fy, fz } = g;
    const d = this.data;
    const nx = this.nx;
    const nxy = this.nx * this.ny;
    const b = i + j * nx + k * nxy;
    const v000 = d[b], v100 = d[b + 1], v010 = d[b + nx], v110 = d[b + nx + 1];
    const v001 = d[b + nxy], v101 = d[b + nxy + 1], v011 = d[b + nxy + nx], v111 = d[b + nxy + nx + 1];
    const c00 = v000 * (1 - fx) + v100 * fx;
    const c10 = v010 * (1 - fx) + v110 * fx;
    const c01 = v001 * (1 - fx) + v101 * fx;
    const c11 = v011 * (1 - fx) + v111 * fx;
    out.d = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
    out.gx =
      (((v100 - v000) * (1 - fy) + (v110 - v010) * fy) * (1 - fz) + ((v101 - v001) * (1 - fy) + (v111 - v011) * fy) * fz) /
      this.voxel;
    out.gy = ((c10 - c00) * (1 - fz) + (c11 - c01) * fz) / this.voxel;
    out.gz = (c01 * (1 - fy) + c11 * fy - (c00 * (1 - fy) + c10 * fy)) / this.voxel;
    return true;
  }

  private cell(x: number, y: number, z: number) {
    const gx = (x - this.ox) / this.voxel;
    const gy = (y - this.oy) / this.voxel;
    const gz = (z - this.oz) / this.voxel;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const k = Math.floor(gz);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx - 1 || j >= this.ny - 1 || k >= this.nz - 1) return null;
    return { i, j, k, fx: gx - i, fy: gy - j, fz: gz - k };
  }

  /** Inside test at a point. */
  inside(x: number, y: number, z: number): boolean {
    return this.sample(x, y, z) < 0;
  }
}

/** @param tris 9 floats (3 vertices) per triangle. */
export function buildSDF(tris: Float32Array, opts: SDFOptions): SDFGrid {
  const v = opts.voxel;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
    minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
    minZ = Math.min(minZ, tris[i + 2]); maxZ = Math.max(maxZ, tris[i + 2]);
  }
  const pad = 5 * v;
  const ox = minX - pad;
  const oy = minY - pad;
  const oz = minZ - pad;
  const nx = Math.ceil((maxX - minX + 2 * pad) / v) + 1;
  const ny = Math.ceil((maxY - minY + 2 * pad) / v) + 1;
  const nz = Math.ceil((maxZ - minZ + 2 * pad) / v) + 1;
  const N = nx * ny * nz;
  const nxy = nx * ny;

  // 1. surface voxels
  const surf = new Uint8Array(N);
  const mark = (x: number, y: number, z: number) => {
    const i = Math.floor((x - ox) / v);
    const j = Math.floor((y - oy) / v);
    const k = Math.floor((z - oz) / v);
    surf[i + j * nx + k * nxy] = 1;
  };
  const step = v * 0.5;
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const L = Math.max(
      Math.hypot(bx - ax, by - ay, bz - az),
      Math.hypot(cx - ax, cy - ay, cz - az),
      Math.hypot(cx - bx, cy - by, cz - bz),
    );
    const n = Math.max(1, Math.ceil(L / step));
    for (let a = 0; a <= n; a++) {
      for (let b = 0; a + b <= n; b++) {
        const u = a / n;
        const w = b / n;
        const s = 1 - u - w;
        mark(ax * s + bx * u + cx * w, ay * s + by * u + cy * w, az * s + bz * u + cz * w);
      }
    }
  }

  // 2. exterior flood fill (6-connected)
  const ext = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  const seed = (idx: number) => {
    if (!surf[idx] && !ext[idx]) {
      ext[idx] = 1;
      queue[qt++] = idx;
    }
  };
  seed(0);
  while (qh < qt) {
    const idx = queue[qh++];
    const i = idx % nx;
    const j = ((idx / nx) | 0) % ny;
    const k = (idx / nxy) | 0;
    if (i > 0) seed(idx - 1);
    if (i < nx - 1) seed(idx + 1);
    if (j > 0) seed(idx - nx);
    if (j < ny - 1) seed(idx + nx);
    if (k > 0) seed(idx - nxy);
    if (k < nz - 1) seed(idx + nxy);
  }
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = ext[i] ? 0 : 1;

  // optional: close the gap between the legs
  if (opts.fillGap) {
    const { y0, y1, maxGap } = opts.fillGap;
    const j0 = Math.max(0, Math.floor((y0 - oy) / v));
    const j1 = Math.min(ny - 1, Math.floor((y1 - oy) / v));
    for (let j = j0; j <= j1; j++) {
      const allow = (maxGap * (0.25 + (0.75 * (j - j0)) / Math.max(1, j1 - j0))) / v;
      for (let k = 0; k < nz; k++) {
        const row = j * nx + k * nxy;
        let first = -1;
        let last = -1;
        for (let i = 0; i < nx; i++) {
          if (inside[row + i]) {
            if (first < 0) first = i;
            last = i;
          }
        }
        if (first < 0) continue;
        // fill each internal gap that is narrower than `allow`
        let i = first;
        while (i <= last) {
          if (inside[row + i]) {
            i++;
            continue;
          }
          let e = i;
          while (e <= last && !inside[row + e]) e++;
          if (e - i <= allow) for (let q = i; q < e; q++) inside[row + q] = 1;
          i = e;
        }
      }
    }
  }

  // 3. distance transform from boundary voxels of the inside
  const INF = 1e20;
  const f = new Float32Array(N);
  for (let idx = 0; idx < N; idx++) {
    let boundary = false;
    if (inside[idx]) {
      const i = idx % nx;
      const j = ((idx / nx) | 0) % ny;
      const k = (idx / nxy) | 0;
      boundary =
        i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1 ||
        !inside[idx - 1] || !inside[idx + 1] || !inside[idx - nx] || !inside[idx + nx] || !inside[idx - nxy] || !inside[idx + nxy];
    }
    f[idx] = boundary ? 0 : INF;
  }
  edt3(f, nx, ny, nz);
  const data = new Float32Array(N);
  for (let idx = 0; idx < N; idx++) {
    const d = Math.sqrt(f[idx]) * v;
    // boundary voxel centres are half a voxel inside the true surface
    data[idx] = inside[idx] ? -(d + 0.5 * v) : d - 0.5 * v;
  }
  return new SDFGrid(nx, ny, nz, ox, oy, oz, v, data);
}

/** In-place squared Euclidean distance transform (Felzenszwalb & Huttenlocher), voxel units. */
function edt3(f: Float32Array, nx: number, ny: number, nz: number) {
  const maxLen = Math.max(nx, ny, nz);
  const line = new Float32Array(maxLen);
  const out = new Float32Array(maxLen);
  const vtx = new Int32Array(maxLen);
  const z = new Float32Array(maxLen + 1);
  const pass = (n: number, stride: number, starts: number[]) => {
    for (const s of starts) {
      for (let q = 0; q < n; q++) line[q] = f[s + q * stride];
      edt1(line, out, vtx, z, n);
      for (let q = 0; q < n; q++) f[s + q * stride] = out[q];
    }
  };
  const nxy = nx * ny;
  const sx: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sx.push(j * nx + k * nxy);
  pass(nx, 1, sx);
  const sy: number[] = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sy.push(i + k * nxy);
  pass(ny, nx, sy);
  const sz: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sz.push(i + j * nx);
  pass(nz, nxy, sz);
}

function edt1(f: Float32Array, d: Float32Array, v: Int32Array, z: Float32Array, n: number) {
  const cross = (q: number, p: number) => (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
  let k = 0;
  v[0] = 0;
  z[0] = -1e30;
  z[1] = 1e30;
  for (let q = 1; q < n; q++) {
    let s = cross(q, v[k]);
    while (s <= z[k]) {
      k--;
      s = cross(q, v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e30;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}
