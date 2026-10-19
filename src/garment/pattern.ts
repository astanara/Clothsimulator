/**
 * Turns a garment mask into a 2D triangle mesh ("pattern") in pixel coordinates.
 * Boundary points come first, in order around the outline, then interior points on a grid.
 */
import Delaunator from 'delaunator';
import { Pt, resampleLoop, smoothLoop, traceOuterContour } from '../image/contour';

export interface Pattern {
  w: number;
  h: number;
  /** x,y pairs in pixels (y down). */
  pts: Float32Array;
  /** Triangles, wound counter-clockwise when seen from the front in world space (y up). */
  tris: Uint32Array;
  /** Indices into pts of the outline, in order. */
  boundary: number[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Mean spacing between points in pixels. */
  spacing: number;
  mask: Uint8Array;
}

/** @param cells approximate number of mesh cells along the longest side of the garment. */
export function buildPattern(mask: Uint8Array, w: number, h: number, cells = 44): Pattern | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  const spacing = Math.max(3, Math.max(maxX - minX, maxY - minY) / cells);

  const raw = traceOuterContour(mask, w, h);
  if (raw.length < 12) return null;
  const outline = resampleLoop(smoothLoop(raw, 3, 3), spacing);

  const dt = distanceToBackground(mask, w, h);
  const pts: Pt[] = [...outline];
  for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
    for (let x = minX + spacing / 2; x <= maxX; x += spacing) {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (mask[iy * w + ix] && dt[iy * w + ix] >= spacing * 0.75) pts.push([x, y]);
    }
  }

  const coords = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => {
    coords[i * 2] = p[0];
    coords[i * 2 + 1] = p[1];
  });
  const del = new Delaunator(coords);
  // Outline points lie on pixel cracks, so test the pixels on both sides of the point.
  const at = (ix: number, iy: number) => ix >= 0 && iy >= 0 && ix < w && iy < h && mask[iy * w + ix] === 1;
  const inside = (x: number, y: number) => {
    const x0 = Math.floor(x - 0.5);
    const y0 = Math.floor(y - 0.5);
    return at(x0, y0) || at(x0 + 1, y0) || at(x0, y0 + 1) || at(x0 + 1, y0 + 1);
  };
  const keep: number[] = [];
  for (let t = 0; t < del.triangles.length; t += 3) {
    const a = del.triangles[t];
    const b = del.triangles[t + 1];
    const c = del.triangles[t + 2];
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const [cx, cy] = pts[c];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(cross) < 1e-6) continue;
    if (
      !inside((ax + bx + cx) / 3, (ay + by + cy) / 3) ||
      !inside((ax + bx) / 2, (ay + by) / 2) ||
      !inside((bx + cx) / 2, (by + cy) / 2) ||
      !inside((cx + ax) / 2, (cy + ay) / 2)
    )
      continue;
    // world-CCW (y flipped) means negative cross in pixel space
    if (cross < 0) keep.push(a, b, c);
    else keep.push(a, c, b);
  }

  // Drop points no triangle uses, remap indices.
  const used = new Uint8Array(pts.length);
  for (const i of keep) used[i] = 1;
  const remap = new Int32Array(pts.length).fill(-1);
  let m = 0;
  for (let i = 0; i < pts.length; i++) if (used[i]) remap[i] = m++;
  const outPts = new Float32Array(m * 2);
  for (let i = 0; i < pts.length; i++) {
    if (remap[i] >= 0) {
      outPts[remap[i] * 2] = pts[i][0];
      outPts[remap[i] * 2 + 1] = pts[i][1];
    }
  }
  const boundary: number[] = [];
  for (let i = 0; i < outline.length; i++) if (remap[i] >= 0) boundary.push(remap[i]);
  return {
    w,
    h,
    pts: outPts,
    tris: Uint32Array.from(keep, (i) => remap[i]),
    boundary,
    bbox: { minX, minY, maxX, maxY },
    spacing,
    mask,
  };
}

/** Chamfer distance transform: distance (px) from each foreground pixel to the nearest background pixel. */
export function distanceToBackground(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const S = Math.SQRT2;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + S, at(x + 1, y - 1) + S);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + S, at(x - 1, y + 1) + S);
    }
  }
  return d;
}
