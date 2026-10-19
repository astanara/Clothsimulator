/** A procedurally generated humanoid "scan" (closed ellipsoids), used for the demo button and tests. */
import type { RawMesh } from './normalize';

interface Ell {
  c: [number, number, number];
  r: [number, number, number];
  /** tilt about +z in degrees */
  tilt?: number;
}

export function demoScanMesh(): RawMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const add = (e: Ell, lat = 18, lon = 28) => {
    const base = pos.length / 3;
    const t = ((e.tilt ?? 0) * Math.PI) / 180;
    for (let i = 0; i <= lat; i++) {
      const th = (i / lat) * Math.PI;
      for (let j = 0; j <= lon; j++) {
        const ph = (j / lon) * Math.PI * 2;
        const x = e.r[0] * Math.sin(th) * Math.cos(ph);
        const y = e.r[1] * Math.cos(th);
        const z = e.r[2] * Math.sin(th) * Math.sin(ph);
        pos.push(e.c[0] + x * Math.cos(t) - y * Math.sin(t), e.c[1] + x * Math.sin(t) + y * Math.cos(t), e.c[2] + z);
      }
    }
    for (let i = 0; i < lat; i++) {
      for (let j = 0; j < lon; j++) {
        const a = base + i * (lon + 1) + j;
        const b = a + lon + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  };
  // y up, facing +z, about 1.75 m tall; deliberately not the parametric proportions
  add({ c: [0, 1.3, 0], r: [0.17, 0.15, 0.11] }); // chest
  add({ c: [0, 1.12, 0], r: [0.15, 0.18, 0.1] }); // waist
  add({ c: [0, 0.93, 0], r: [0.17, 0.14, 0.115] }); // hips
  add({ c: [0, 1.42, 0], r: [0.19, 0.05, 0.09] }); // shoulders
  add({ c: [0, 1.53, 0], r: [0.05, 0.08, 0.05] }); // neck
  add({ c: [0, 1.65, 0.01], r: [0.085, 0.11, 0.1] }); // head
  for (const s of [-1, 1]) {
    add({ c: [s * 0.09, 0.68, 0], r: [0.085, 0.27, 0.088], tilt: s * -1 }, 20, 20); // thigh
    add({ c: [s * 0.095, 0.25, 0], r: [0.052, 0.26, 0.056] }, 20, 20); // calf
    add({ c: [s * 0.095, 0.04, 0.05], r: [0.05, 0.04, 0.12] }, 10, 12); // foot (toes forward)
    add({ c: [s * 0.275, 1.265, 0], r: [0.045, 0.16, 0.045], tilt: s * 30 }, 14, 14); // upper arm
    add({ c: [s * 0.396, 1.013, 0], r: [0.038, 0.15, 0.038], tilt: s * 20 }, 14, 14); // forearm
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

/** Wavefront OBJ text for the demo scan. */
export function demoScanOBJ(): string {
  const m = demoScanMesh();
  const lines: string[] = ['# demo scan'];
  for (let i = 0; i < m.pos.length; i += 3) lines.push(`v ${m.pos[i]} ${m.pos[i + 1]} ${m.pos[i + 2]}`);
  for (let i = 0; i < m.idx.length; i += 3) lines.push(`f ${m.idx[i] + 1} ${m.idx[i + 1] + 1} ${m.idx[i + 2] + 1}`);
  return lines.join('\n');
}
