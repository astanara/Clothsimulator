/**
 * Garment segmentation from a photo: separates the clothing from the background.
 * Works on cut-out PNGs (alpha channel) and on photos with a fairly uniform background.
 */

export interface SegmentResult {
  /** 1 = garment, 0 = background; length w*h. */
  mask: Uint8Array;
  /** The mask before thin features were removed (equal to `mask` otherwise). */
  fullMask: Uint8Array;
  /** Colour-distance threshold that was used (0..441). */
  threshold: number;
  usedAlpha: boolean;
}

export interface SegmentOptions {
  /** Remove features thinner than about this many pixels (spaghetti straps, ties) before meshing. */
  removeThinBelow?: number;
  /** Colour distance from the background colour; auto (Otsu) when omitted. */
  threshold?: number;
  /** Pixels to erode the mask by, to avoid background fringes on the texture. */
  erode?: number;
}

export function segment(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  opts: SegmentOptions = {},
): SegmentResult {
  const n = w * h;
  let raw: Uint8Array = new Uint8Array(n);
  let usedAlpha = false;
  let threshold = 0;

  let transparent = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 128) transparent++;
  if (transparent > n * 0.02) {
    usedAlpha = true;
    for (let i = 0; i < n; i++) raw[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    const bg = borderColour(rgba, w, h);
    const dist = new Float32Array(n);
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(rgba[i * 4] - bg[0], rgba[i * 4 + 1] - bg[1], rgba[i * 4 + 2] - bg[2]);
      dist[i] = d;
      hist[Math.min(255, Math.floor((d * 255) / 441.67))]++;
    }
    // Prefer the strict (Otsu) threshold: it ignores soft shadows beside the garment. Only if that
    // breaks the garment into pieces (white stripes on a pale backdrop...) try the looser one.
    const [strict, loose] = autoThresholds(hist, dist, w, h);
    const candidates = opts.threshold !== undefined ? [opts.threshold] : loose < strict ? [strict, loose] : [strict];
    for (let c = 0; c < candidates.length; c++) {
      threshold = candidates[c];
      for (let i = 0; i < n; i++) raw[i] = dist[i] > threshold ? 1 : 0;
      let ok = false;
      for (const r of [0, 2, 4, 7, 11]) {
        const closed = r ? close(raw, w, h, r) : raw;
        const total = closed.reduce((a, v) => a + v, 0);
        const big = largestComponent(fillHoles(closed, w, h), w, h).reduce((a, v) => a + v, 0);
        if (total > 0 && big / total >= 0.9) {
          raw = closed;
          ok = true;
          break;
        }
      }
      if (ok || c === candidates.length - 1) break;
    }
  }

  raw = fillHoles(raw, w, h);
  raw = largestComponent(raw, w, h);
  raw = erode(raw, w, h, opts.erode ?? 3);
  raw = largestComponent(raw, w, h);
  const full = raw;
  if (opts.removeThinBelow && opts.removeThinBelow > 1) {
    const r = Math.ceil(opts.removeThinBelow / 2);
    raw = largestComponent(dilate(erode(raw, w, h, r), w, h, r), w, h);
  }
  return { mask: raw, fullMask: full, threshold, usedAlpha };
}

function borderColour(rgba: ArrayLike<number>, w: number, h: number): number[] {
  const ch: number[][] = [[], [], []];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) ch[c].push(rgba[i + c]);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    push(0, y);
    push(w - 1, y);
  }
  return ch.map((a) => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  });
}

/**
 * [strict, loose] colour-distance thresholds: Otsu's split, and the backdrop's own noise level
 * (mean + 4 sigma of the border), which keeps garment areas that are only slightly different from
 * the backdrop but also keeps soft shadows.
 */
function autoThresholds(hist: Float64Array, dist: Float32Array, w: number, h: number): [number, number] {
  let sum = 0;
  let sum2 = 0;
  let cnt = 0;
  const add = (x: number, y: number) => {
    const d = dist[y * w + x];
    sum += d;
    sum2 += d * d;
    cnt++;
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    add(w - 1, y);
  }
  const mean = sum / cnt;
  const sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
  const noise = Math.max(14, mean + 4 * sd);
  const strict = otsu(hist) * (441.67 / 255);
  return [strict, Math.min(noise, strict)];
}

export function dilate(fg: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = fg;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] =
          cur[i] || (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w]) ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}

export function close(fg: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = fg;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] =
          cur[i] || (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])
            ? 1
            : 0;
      }
    }
    cur = out;
  }
  // erode back (pixels outside the image count as foreground so borders are not eaten)
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] =
          cur[i] && (x === 0 || cur[i - 1]) && (x === w - 1 || cur[i + 1]) && (y === 0 || cur[i - w]) && (y === h - 1 || cur[i + w])
            ? 1
            : 0;
      }
    }
    cur = out;
  }
  return cur;
}

function otsu(hist: Float64Array): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 16;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  // keep a minimum so JPEG noise on a flat background is never "garment"
  return Math.max(bestT, 10);
}

/** Anything not reachable from the border through background is garment (fills holes/prints). */
function fillHoles(fg: Uint8Array, w: number, h: number): Uint8Array {
  const reach = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  const seed = (i: number) => {
    if (!fg[i] && !reach[i]) {
      reach[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = reach[i] ? 0 : 1;
  return out;
}

export function largestComponent(fg: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let s = 0; s < fg.length; s++) {
    if (!fg[s] || label[s]) continue;
    next++;
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    label[s] = next;
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w;
      const y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && fg[j] && !label[j]) {
          label[j] = next;
          queue[qt++] = j;
        }
      }
    }
    if (qt > bestSize) {
      bestSize = qt;
      best = next;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

export function erode(fg: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = fg;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        out[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}
