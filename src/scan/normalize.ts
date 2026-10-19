/** Bring a scanned body mesh into the simulator's frame: +y up, feet on the floor, facing +z, true height. */

export interface RawMesh {
  /** xyz per vertex */
  pos: Float32Array;
  /** 3 indices per triangle */
  idx: Uint32Array;
}

export interface NormalizedScan extends RawMesh {
  /** Quarter turns about +y that were applied to face the scan forward (before the user's extra turns). */
  autoTurns: number;
}

export function bounds(pos: Float32Array) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pos[i + k]);
      mx[k] = Math.max(mx[k], pos[i + k]);
    }
  }
  return { mn, mx, ext: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

/** Rotate by 90° steps about +y. */
export function rotateY(pos: Float32Array, turns: number): Float32Array {
  const t = ((turns % 4) + 4) % 4;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const z = pos[i + 2];
    let nx = x;
    let nz = z;
    for (let k = 0; k < t; k++) {
      const tx = nz;
      nz = -nx;
      nx = tx;
    }
    out[i] = nx;
    out[i + 1] = pos[i + 1];
    out[i + 2] = nz;
  }
  return out;
}

/**
 * @param heightCm the person's real height; the mesh is scaled to it.
 * @param extraTurns additional quarter turns about +y chosen by the user to fix the facing direction.
 */
export function normalizeScan(mesh: RawMesh, heightCm: number, extraTurns = 0): NormalizedScan {
  let pos: Float32Array = Float32Array.from(mesh.pos);
  let b = bounds(pos);

  // Up axis: the tallest extent. Arm span can rival height in a T-pose, so prefer +y when it is close.
  const [ex, ey, ez] = b.ext;
  const biggest = Math.max(ex, ey, ez);
  if (ey < 0.85 * biggest) {
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (ez >= ex) {
        pos[i + 1] = z; // z-up -> y-up
        pos[i + 2] = -y;
      } else {
        pos[i] = -y; // x-up -> y-up
        pos[i + 1] = x;
      }
    }
    b = bounds(pos);
  }

  const h0 = b.ext[1];
  // Facing: toes point forward, so the feet sit in front of the shins.
  const band = (lo: number, hi: number, p: Float32Array) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < p.length; i += 3) {
      const t = (p[i + 1] - b.mn[1]) / h0;
      if (t >= lo && t <= hi) {
        s += p[i + 2];
        n++;
      }
    }
    return n ? s / n : 0;
  };
  let bestTurns = 0;
  let bestDz = -Infinity;
  for (let q = 0; q < 4; q++) {
    const r = rotateY(pos, q);
    const dz = band(0, 0.05, r) - band(0.12, 0.3, r);
    if (dz > bestDz) {
      bestDz = dz;
      bestTurns = q;
    }
  }
  pos = rotateY(pos, bestTurns + extraTurns);

  // scale, floor, centre on the torso
  b = bounds(pos);
  const s = heightCm / 100 / (b.mx[1] - b.mn[1]);
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const t = (pos[i + 1] - b.mn[1]) / (b.mx[1] - b.mn[1]);
    if (t > 0.45 && t < 0.75) {
      cx += pos[i];
      cz += pos[i + 2];
      n++;
    }
  }
  if (n) {
    cx /= n;
    cz /= n;
  }
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - cx) * s;
    pos[i + 1] = (pos[i + 1] - b.mn[1]) * s;
    pos[i + 2] = (pos[i + 2] - cz) * s;
  }
  return { pos, idx: mesh.idx, autoTurns: bestTurns };
}

/** Triangle soup (9 floats per triangle) from an indexed mesh. */
export function toSoup(mesh: RawMesh): Float32Array {
  const out = new Float32Array(mesh.idx.length * 3);
  for (let t = 0; t < mesh.idx.length; t++) {
    const v = mesh.idx[t] * 3;
    out[t * 3] = mesh.pos[v];
    out[t * 3 + 1] = mesh.pos[v + 1];
    out[t * 3 + 2] = mesh.pos[v + 2];
  }
  return out;
}
