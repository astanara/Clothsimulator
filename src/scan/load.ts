/** Read a body scan file (OBJ, GLB/GLTF, PLY, STL) into one merged indexed mesh. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { RawMesh } from './normalize';

export async function loadScanFile(file: File): Promise<RawMesh> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const geos: THREE.BufferGeometry[] = [];
  const collect = (root: THREE.Object3D) => {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        geos.push(g);
      }
    });
  };
  if (ext === 'obj') {
    collect(new OBJLoader().parse(await file.text()));
  } else if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
    collect(gltf.scene);
  } else if (ext === 'ply') {
    geos.push(new PLYLoader().parse(await file.arrayBuffer()));
  } else if (ext === 'stl') {
    geos.push(new STLLoader().parse(await file.arrayBuffer()));
  } else {
    throw new Error(`Unsupported scan format ".${ext}" (use OBJ, GLB, GLTF, PLY or STL)`);
  }
  return mergeGeometries(geos);
}

function mergeGeometries(geos: THREE.BufferGeometry[]): RawMesh {
  let nv = 0;
  let ni = 0;
  for (const g of geos) {
    nv += g.getAttribute('position').count;
    ni += g.index ? g.index.count : g.getAttribute('position').count;
  }
  if (!nv) throw new Error('No mesh found in the file');
  const pos = new Float32Array(nv * 3);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i);
      pos[(vo + i) * 3 + 1] = p.getY(i);
      pos[(vo + i) * 3 + 2] = p.getZ(i);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    } else {
      for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
    }
    vo += p.count;
  }
  return { pos, idx };
}
