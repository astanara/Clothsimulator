/** Register a photo of the garment (front, back, ...) onto the flat pattern so the photo can be used as its texture. */

export interface MaskImage {
  mask: Uint8Array;
  w: number;
  h: number;
}

/** pattern px -> photo px: x' = ox + m*sx*(x - cx), y' = oy + sy*(y - cy) */
export interface Affine {
  m: 1 | -1;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  cx: number;
  cy: number;
}

export function applyAffine(t: Affine, x: number, y: number): [number, number] {
  return [t.ox + t.m * t.sx * (x - t.cx), t.oy + t.sy * (y - t.cy)];
}

export function maskBBox(img: MaskImage) {
  let minX = img.w, minY = img.h, maxX = -1, maxY = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.mask[y * img.w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX: maxX + 1, maxY: maxY + 1 };
}

function iou(pat: MaskImage, pb: ReturnType<typeof maskBBox>, photo: MaskImage, t: Affine): number {
  const N = 56;
  let inter = 0;
  let union = 0;
  for (let j = 0; j < N; j++) {
    const y = pb.minY + ((j + 0.5) / N) * (pb.maxY - pb.minY);
    for (let i = 0; i < N; i++) {
      const x = pb.minX + ((i + 0.5) / N) * (pb.maxX - pb.minX);
      const p = pat.mask[Math.floor(y) * pat.w + Math.floor(x)] === 1;
      const [qx, qy] = applyAffine(t, x, y);
      const ix = Math.floor(qx);
      const iy = Math.floor(qy);
      const q = ix >= 0 && iy >= 0 && ix < photo.w && iy < photo.h && photo.mask[iy * photo.w + ix] === 1;
      if (p && q) inter++;
      if (p || q) union++;
    }
  }
  return union ? inter / union : 0;
}

/**
 * Find the scale/offset that best overlays the photo's garment silhouette on the pattern's.
 * `mirror` is true for back photos (a garment seen from behind is a left-right mirror image).
 * With 'auto' both are tried.
 */
export function alignMask(
  pattern: MaskImage,
  photo: MaskImage,
  mirror: boolean | 'auto',
): { transform: Affine; iou: number } {
  const pb = maskBBox(pattern);
  const qb = maskBBox(photo);
  const pw = pb.maxX - pb.minX;
  const ph = pb.maxY - pb.minY;
  const run = (m: 1 | -1) => {
    const t: Affine = {
      m,
      sx: (qb.maxX - qb.minX) / pw,
      sy: (qb.maxY - qb.minY) / ph,
      ox: (qb.minX + qb.maxX) / 2,
      oy: (qb.minY + qb.maxY) / 2,
      cx: (pb.minX + pb.maxX) / 2,
      cy: (pb.minY + pb.maxY) / 2,
    };
    let best = iou(pattern, pb, photo, t);
    let step = 0.04;
    for (let iter = 0; iter < 40 && step > 0.002; iter++) {
      let improved = false;
      for (const key of ['sx', 'sy', 'ox', 'oy'] as const) {
        for (const dir of [-1, 1]) {
          const c = { ...t };
          const scale = key === 'sx' || key === 'sy' ? 1 + dir * step : 0;
          if (scale) c[key] = t[key] * scale;
          else c[key] = t[key] + dir * step * (key === 'ox' ? qb.maxX - qb.minX : qb.maxY - qb.minY);
          const s = iou(pattern, pb, photo, c);
          if (s > best + 1e-6) {
            best = s;
            Object.assign(t, c);
            improved = true;
          }
        }
      }
      if (!improved) step /= 2;
    }
    return { transform: t, iou: best };
  };
  if (mirror === 'auto') {
    const a = run(1);
    const b = run(-1);
    // symmetric garments match both ways; a back view is normally the mirrored one
    return b.iou + 0.03 >= a.iou ? b : a;
  }
  return run(mirror ? -1 : 1);
}
