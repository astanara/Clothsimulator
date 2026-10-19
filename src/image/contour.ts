/** Outer-boundary tracing of a binary mask, returned as a smooth, evenly spaced closed polyline. */

export type Pt = [number, number];

/** Trace the largest boundary loop of `mask` along pixel edges (fg on the right-hand side). */
export function traceOuterContour(mask: Uint8Array, w: number, h: number): Pt[] {
  const W = w + 1;
  // directions: 0 right, 1 down, 2 left, 3 up
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  // out[vertex] bit d set = an unvisited edge leaves the vertex in direction d
  const out = new Uint8Array(W * (h + 1));
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!fg(x, y)) continue;
      if (!fg(x, y - 1)) out[y * W + x] |= 1; // top edge, going right
      if (!fg(x + 1, y)) out[y * W + x + 1] |= 2; // right edge, going down
      if (!fg(x, y + 1)) out[(y + 1) * W + x + 1] |= 4; // bottom edge, going left
      if (!fg(x - 1, y)) out[(y + 1) * W + x] |= 8; // left edge, going up
    }
  }
  let best: Pt[] = [];
  let bestArea = 0;
  for (let start = 0; start < out.length; start++) {
    while (out[start]) {
      const sx = start % W;
      const sy = (start / W) | 0;
      let d = 0;
      while (!(out[start] & (1 << d))) d++;
      const loop: Pt[] = [];
      let x = sx;
      let y = sy;
      for (;;) {
        out[y * W + x] &= ~(1 << d);
        loop.push([x, y]);
        x += DX[d];
        y += DY[d];
        if (x === sx && y === sy) break;
        const bits = out[y * W + x];
        // prefer a right turn so diagonal pixels stay separate, then straight, then left
        let nd = -1;
        for (const c of [(d + 1) % 4, d, (d + 3) % 4]) {
          if (bits & (1 << c)) {
            nd = c;
            break;
          }
        }
        if (nd < 0) break;
        d = nd;
      }
      const area = Math.abs(polygonArea(loop));
      if (area > bestArea) {
        bestArea = area;
        best = loop;
      }
    }
  }
  return best;
}

export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** Circular moving-average smoothing. */
export function smoothLoop(p: Pt[], radius: number, passes: number): Pt[] {
  let cur = p;
  const n = p.length;
  for (let k = 0; k < passes; k++) {
    const next: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      for (let j = -radius; j <= radius; j++) {
        const q = cur[(i + j + n) % n];
        sx += q[0];
        sy += q[1];
      }
      next[i] = [sx / (2 * radius + 1), sy / (2 * radius + 1)];
    }
    cur = next;
  }
  return cur;
}

/** Resample a closed loop to points `spacing` apart (by arc length). */
export function resampleLoop(p: Pt[], spacing: number): Pt[] {
  const n = p.length;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const q = p[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]));
  }
  const total = cum[n];
  const count = Math.max(8, Math.round(total / spacing));
  const out: Pt[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (cum[seg + 1] < target) seg++;
    const t = (target - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    const a = p[seg];
    const b = p[(seg + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
