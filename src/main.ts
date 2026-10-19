import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Body, BodyMeasurements, DEFAULT_BODY, LANDMARKS } from './body';
import { Cloth } from './cloth';
import { FABRICS, FabricId, SIZES, analyseFit } from './fit';
import { measureGarment } from './garment/measure';
import { Pattern, buildPattern } from './garment/pattern';
import { PRESETS, PresetId, autoOpenings, estimateArmAngle, getPreset } from './garment/presets';
import { segment } from './image/segment';
import { SAMPLES, drawSample } from './samples';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- three.js scene ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171c);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 20);
camera.position.set(0, 1.2, 3.0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(2, 3, 3);
scene.add(sun);
scene.add(new THREE.GridHelper(3, 12, 0x333844, 0x252932));

// ---------- state ----------
const bodyM: BodyMeasurements = { ...DEFAULT_BODY };
const st = {
  preset: 'top' as PresetId,
  length: 70,
  sizeIdx: 1,
  fabric: 'woven' as FabricId,
  threshold: undefined as number | undefined,
  offset: 0,
  armAuto: true,
  arm: 30,
  mode: 'photo' as 'photo' | 'strain' | 'gap',
};
let srcCanvas: HTMLCanvasElement = document.createElement('canvas');
let pattern: Pattern | null = null;
let openings: Uint8Array = new Uint8Array(0);
let cloth: Cloth | null = null;
let clothMesh: THREE.Mesh | null = null;
let bodyObj: THREE.Object3D | null = null;
let texture: THREE.CanvasTexture | null = null;
const clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92 });

// ---------- UI wiring ----------
const bodyFields: [keyof BodyMeasurements, string, number, number][] = [
  ['height', 'Height', 150, 200],
  ['chest', 'Chest', 76, 140],
  ['waist', 'Waist', 60, 140],
  ['hip', 'Hip', 80, 140],
  ['shoulderWidth', 'Shoulders', 36, 56],
];
for (const [key, label, min, max] of bodyFields) {
  const l = document.createElement('label');
  l.innerHTML = `${label}<input type="range" min="${min}" max="${max}" value="${bodyM[key]}"><output>${bodyM[key]}</output>`;
  const input = l.querySelector('input')!;
  const out = l.querySelector('output')!;
  input.addEventListener('input', () => {
    bodyM[key] = +input.value;
    out.textContent = input.value;
  });
  input.addEventListener('change', rebuild);
  $('body-controls').appendChild(l);
}
const opt = (v: string, t: string) => `<option value="${v}">${t}</option>`;
$<HTMLSelectElement>('sample').innerHTML = SAMPLES.map((s) => opt(s.id, s.label)).join('');
$<HTMLSelectElement>('preset').innerHTML = PRESETS.map((p) => opt(p.id, p.label)).join('');
$<HTMLSelectElement>('size').innerHTML = SIZES.map((s, i) => opt(String(i), `${s.name} (${Math.round(s.scale * 100)}%)`)).join('');
$<HTMLSelectElement>('fabric').innerHTML = Object.entries(FABRICS).map(([k, f]) => opt(k, f.label)).join('');
$<HTMLSelectElement>('size').value = String(st.sizeIdx);

$<HTMLSelectElement>('sample').addEventListener('change', (e) => loadSample((e.target as HTMLSelectElement).value));
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  st.threshold = undefined;
  setSource(c);
});
$<HTMLSelectElement>('preset').addEventListener('change', (e) => {
  st.preset = (e.target as HTMLSelectElement).value as PresetId;
  st.length = getPreset(st.preset).length;
  $<HTMLInputElement>('length').value = String(st.length);
  if (pattern) openings = autoOpenings(pattern, getPreset(st.preset));
  rebuild();
});
$<HTMLInputElement>('length').addEventListener('change', (e) => {
  st.length = Math.max(20, +(e.target as HTMLInputElement).value || st.length);
  rebuild();
});
$<HTMLSelectElement>('size').addEventListener('change', (e) => {
  st.sizeIdx = +(e.target as HTMLSelectElement).value;
  rebuild();
});
$<HTMLSelectElement>('fabric').addEventListener('change', (e) => {
  st.fabric = (e.target as HTMLSelectElement).value as FabricId;
  rebuild();
});
$<HTMLInputElement>('threshold').addEventListener('input', (e) => {
  st.threshold = +(e.target as HTMLInputElement).value;
  $('threshold-out').textContent = String(st.threshold);
});
$<HTMLInputElement>('threshold').addEventListener('change', () => processImage());
$<HTMLInputElement>('offset').addEventListener('input', (e) => {
  st.offset = +(e.target as HTMLInputElement).value;
  $('offset-out').textContent = String(st.offset);
});
$<HTMLInputElement>('offset').addEventListener('change', rebuild);
$<HTMLInputElement>('arm').addEventListener('input', (e) => {
  st.armAuto = false;
  st.arm = +(e.target as HTMLInputElement).value;
  $('arm-out').textContent = String(st.arm);
});
$<HTMLInputElement>('arm').addEventListener('change', rebuild);
$<HTMLSelectElement>('mode').addEventListener('change', (e) => {
  st.mode = (e.target as HTMLSelectElement).value as typeof st.mode;
  clothMat.map = st.mode === 'photo' ? texture : null;
  clothMat.needsUpdate = true;
  $('legend').style.display = st.mode === 'photo' ? 'none' : 'block';
});
$('resim').addEventListener('click', rebuild);

// ---------- garment pipeline: photo -> mask -> pattern ----------
function loadSample(id: string) {
  const def = SAMPLES.find((s) => s.id === id)!;
  st.preset = def.preset;
  st.length = getPreset(def.preset).length;
  st.threshold = undefined;
  $<HTMLSelectElement>('preset').value = st.preset;
  $<HTMLInputElement>('length').value = String(st.length);
  setSource(drawSample(def, 400));
}

function setSource(c: HTMLCanvasElement) {
  srcCanvas = c;
  texture?.dispose();
  texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  clothMat.map = st.mode === 'photo' ? texture : null;
  clothMat.needsUpdate = true;
  processImage();
}

function processImage() {
  // work at modest resolution; the full-size image is only used as the texture
  const k = Math.min(1, 420 / Math.max(srcCanvas.width, srcCanvas.height));
  const w = Math.round(srcCanvas.width * k);
  const h = Math.round(srcCanvas.height * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  const seg = segment(ctx.getImageData(0, 0, w, h).data, w, h, { threshold: st.threshold });
  const slider = $<HTMLInputElement>('threshold');
  if (st.threshold === undefined) {
    slider.value = String(Math.round(seg.threshold));
    $('threshold-out').textContent = seg.usedAlpha ? 'alpha' : 'auto';
  }
  pattern = buildPattern(seg.mask, w, h);
  if (!pattern) {
    $('status').textContent = 'Could not find a garment in this image — try the cut-out slider.';
    return;
  }
  openings = autoOpenings(pattern, getPreset(st.preset));
  rebuild();
}

// ---------- body + cloth ----------
function bodyMesh(b: Body): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc89b7b, roughness: 0.8 });
  const S = b.sections;
  const seg = 48;
  const verts: number[] = [];
  const idx: number[] = [];
  for (const s of S.filter((q) => q.y >= b.visibleYMin - 1e-6)) {
    for (let r = 0; r <= seg; r++) {
      const t = (r / seg) * Math.PI * 2;
      verts.push(Math.sin(t) * s.a, s.y, Math.cos(t) * s.b);
    }
  }
  const rows = S.filter((q) => q.y >= b.visibleYMin - 1e-6).length;
  for (let i = 0; i < rows - 1; i++) {
    for (let r = 0; r < seg; r++) {
      const a = i * (seg + 1) + r;
      const c = a + seg + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc89b7b, roughness: 0.8, side: THREE.DoubleSide })));
  for (const c of b.capsules) {
    const a = new THREE.Vector3(...c.a);
    const e = new THREE.Vector3(...c.b);
    const len = a.distanceTo(e);
    if (len < 1e-4) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(c.ra * 0.95, 24, 16), mat);
      head.scale.set(0.92, 1.15, 1);
      head.position.copy(a);
      g.add(head);
      continue;
    }
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.rb, c.ra, len, 20), mat);
    mesh.position.copy(a).add(e).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.clone().sub(a).normalize());
    g.add(mesh);
    for (const [pt, r] of [[a, c.ra], [e, c.rb]] as const) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
      ball.position.copy(pt);
      g.add(ball);
    }
  }
  return g;
}

function rebuild() {
  if (bodyObj) scene.remove(bodyObj);
  if (clothMesh) {
    scene.remove(clothMesh);
    clothMesh.geometry.dispose();
    clothMesh = null;
  }
  cloth = null;
  if (!pattern) return;

  const preset = getPreset(st.preset);
  const fabric = FABRICS[st.fabric];
  const H = bodyM.height / 100;
  const patternH = pattern.bbox.maxY - pattern.bbox.minY;
  const metersPerPx = (st.length / 100) * SIZES[st.sizeIdx].scale / patternH;
  const topY = preset.anchor * H + st.offset / 100;

  const sh = new Body(bodyM, 30).sectionAt(LANDMARKS.shoulder * H);
  const arm = st.armAuto ? estimateArmAngle(pattern, metersPerPx, topY, sh.a) : st.arm;
  if (st.armAuto) {
    $<HTMLInputElement>('arm').value = String(Math.round(arm));
    $('arm-out').textContent = 'auto';
  }
  const body = new Body(bodyM, arm, preset.hangsFromHips);
  bodyObj = bodyMesh(body);
  scene.add(bodyObj);

  cloth = new Cloth({
    body,
    pattern,
    openings,
    metersPerPx,
    topY,
    holdTop: preset.holdTop,
    stiffness: fabric.stiffness,
    bend: fabric.bend,
  });
  cloth.settle(160);

  const n = cloth.renderMap.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(cloth.uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(cloth.indices, 1));
  clothMesh = new THREE.Mesh(geo, clothMat);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);
  controls.target.set(0, H * 0.58, 0);

  $('status').textContent = `${cloth.count} particles · ${(cloth.indices.length / 3) | 0} triangles`;
  report(body, metersPerPx, topY);
  drawEditor();
}

function report(body: Body, metersPerPx: number, topY: number) {
  if (!pattern) return;
  const m = measureGarment(pattern, body, metersPerPx, topY, FABRICS[st.fabric].stretch, st.preset === 'top');
  const cls = (v: string) =>
    v === 'too tight' ? 'v-too' : v === 'snug' ? 'v-snug' : v === 'regular' ? 'v-regular' : 'v-loose';
  const rows = analyseFit(bodyM, m);
  $('report').innerHTML =
    '<tr><th>Area</th><th>Body</th><th>Garment</th><th>Ease</th><th>Fit</th></tr>' +
    (rows.length
      ? rows
          .map(
            (f) =>
              `<tr><td>${f.region}</td><td>${f.body}</td><td>${f.garment.toFixed(0)}</td><td>${f.ease > 0 ? '+' : ''}${f.ease.toFixed(0)}</td><td class="${cls(f.verdict)}">${f.verdict}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="5">Garment does not cross chest, waist or hip.</td></tr>');
}

// ---------- 2D outline editor ----------
const editor = $<HTMLCanvasElement>('editor');
const ectx = editor.getContext('2d')!;
function editorTransform() {
  if (!pattern) return { s: 1, ox: 0, oy: 0 };
  const s = Math.min(editor.width / pattern.w, editor.height / pattern.h);
  return { s, ox: (editor.width - pattern.w * s) / 2, oy: (editor.height - pattern.h * s) / 2 };
}
function drawEditor() {
  ectx.clearRect(0, 0, editor.width, editor.height);
  if (!pattern) return;
  const { s, ox, oy } = editorTransform();
  ectx.drawImage(srcCanvas, ox, oy, pattern.w * s, pattern.h * s);
  ectx.strokeStyle = 'rgba(255,255,255,0.25)';
  ectx.lineWidth = 1;
  ectx.beginPath();
  for (let t = 0; t < pattern.tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = pattern.tris[t + e];
      const b = pattern.tris[t + ((e + 1) % 3)];
      ectx.moveTo(ox + pattern.pts[a * 2] * s, oy + pattern.pts[a * 2 + 1] * s);
      ectx.lineTo(ox + pattern.pts[b * 2] * s, oy + pattern.pts[b * 2 + 1] * s);
    }
  }
  ectx.stroke();
  ectx.lineWidth = 5;
  const B = pattern.boundary;
  for (let k = 0; k < B.length; k++) {
    const a = B[k];
    const b = B[(k + 1) % B.length];
    ectx.strokeStyle = openings[k] ? '#f87171' : '#4ade80';
    ectx.beginPath();
    ectx.moveTo(ox + pattern.pts[a * 2] * s, oy + pattern.pts[a * 2 + 1] * s);
    ectx.lineTo(ox + pattern.pts[b * 2] * s, oy + pattern.pts[b * 2 + 1] * s);
    ectx.stroke();
  }
}
let painting: 0 | 1 | null = null;
function paintAt(ev: PointerEvent) {
  if (!pattern || painting === null) return;
  const r = editor.getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * editor.width;
  const py = ((ev.clientY - r.top) / r.height) * editor.height;
  const { s, ox, oy } = editorTransform();
  const brush = 22;
  let hit = false;
  pattern.boundary.forEach((pi, k) => {
    const d = Math.hypot(ox + pattern!.pts[pi * 2] * s - px, oy + pattern!.pts[pi * 2 + 1] * s - py);
    if (d < brush) {
      hit = true;
      if (painting !== null) openings[k] = painting;
    }
  });
  if (hit) drawEditor();
}
editor.addEventListener('pointerdown', (ev) => {
  if (!pattern) return;
  const r = editor.getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * editor.width;
  const py = ((ev.clientY - r.top) / r.height) * editor.height;
  const { s, ox, oy } = editorTransform();
  let best = 1e9;
  let bk = -1;
  pattern.boundary.forEach((pi, k) => {
    const d = Math.hypot(ox + pattern!.pts[pi * 2] * s - px, oy + pattern!.pts[pi * 2 + 1] * s - py);
    if (d < best) {
      best = d;
      bk = k;
    }
  });
  if (bk < 0 || best > 40) return;
  painting = openings[bk] ? 0 : 1;
  editor.setPointerCapture(ev.pointerId);
  paintAt(ev);
});
editor.addEventListener('pointermove', paintAt);
editor.addEventListener('pointerup', () => {
  if (painting !== null) {
    painting = null;
    rebuild();
  }
});

// ---------- render loop ----------
const COLD = new THREE.Color(0x3b82f6);
const NEUTRAL = new THREE.Color(0xe5e7eb);
const HOT = new THREE.Color(0xef4444);
const tmp = new THREE.Color();

function heat(i: number, c: Cloth): THREE.Color {
  let v: number;
  if (st.mode === 'strain') v = Math.max(-1, Math.min(1, (c.strain[i] - 1) * 12));
  else v = Math.max(-1, Math.min(1, (0.03 - c.gap[i]) / 0.03));
  return v >= 0 ? tmp.copy(NEUTRAL).lerp(HOT, v) : tmp.copy(NEUTRAL).lerp(COLD, -v);
}

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function frame() {
  requestAnimationFrame(frame);
  if (cloth && clothMesh) {
    cloth.step();
    const geo = clothMesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const n = cloth.renderMap.length;
    const half = n / 2;
    for (let k = 0; k < n; k++) {
      const p = cloth.renderMap[k];
      pos.setXYZ(k, cloth.pos[p * 3], cloth.pos[p * 3 + 1], cloth.pos[p * 3 + 2]);
      if (st.mode === 'photo') {
        const v = k < half ? 1 : 0.8; // the inside/back is a little darker
        col.setXYZ(k, v, v, v);
      } else {
        const c = heat(p, cloth);
        col.setXYZ(k, c.r, c.g, c.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }
  controls.update();
  renderer.render(scene, camera);
}

resize();
loadSample('tshirt');
frame();

// debugging / screenshot hook
(window as unknown as { __app: unknown }).__app = { camera, controls };
