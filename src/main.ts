import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Affine, alignMask, applyAffine } from './garment/align';
import { Body, BodyMeasurements, BodyModel, DEFAULT_BODY, LANDMARKS } from './body';
import { Cloth } from './cloth';
import { FABRICS, FabricId, SIZES, analyseFit } from './fit';
import { measureGarment, torsoHalfWidth } from './garment/measure';
import { Pattern, buildPattern } from './garment/pattern';
import { PRESETS, PresetId, autoOpenings, estimateArmAngle, getPreset } from './garment/presets';
import { segment } from './image/segment';
import { SAMPLES, drawSample } from './samples';
import { demoScanMesh } from './scan/demoScan';
import { loadScanFile } from './scan/load';
import { NormalizedScan, RawMesh, normalizeScan, toSoup } from './scan/normalize';
import { ScanData } from './scan/scanBody';

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
type Slot = 'front' | 'back' | 'side' | 'flat';
const SLOTS: [Slot, string][] = [
  ['front', 'Front'],
  ['back', 'Back'],
  ['side', 'Side'],
  ['flat', 'Flat-lay (unworn)'],
];
interface Photo {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  mask: Uint8Array;
}
const canvases: Partial<Record<Slot, HTMLCanvasElement>> = {};
let photos: Partial<Record<Slot, Photo>> = {};
let srcPhoto: Photo | null = null;
let srcCanvas: HTMLCanvasElement = document.createElement('canvas');
let uvFront: Float32Array = new Float32Array(0);
let uvBack: Float32Array = new Float32Array(0);
let hasBackPhoto = false;
let pattern: Pattern | null = null;

// body scan state
let scanRaw: RawMesh | null = null;
let scanTurns = 0;
let scanNorm: NormalizedScan | null = null;
let scanData: ScanData | null = null;
let scanObj: THREE.Object3D | null = null;
let openings: Uint8Array = new Uint8Array(0);
let cloth: Cloth | null = null;
let clothMesh: THREE.Mesh | null = null;
let bodyObj: THREE.Object3D | null = null;
let texFront: THREE.CanvasTexture | null = null;
let texBack: THREE.CanvasTexture | null = null;
let texSide: THREE.CanvasTexture | null = null;

// Side photo: projected from +x / -x onto surfaces that face sideways (sleeves, side seams).
const sideUniforms = {
  uSideMap: { value: null as THREE.Texture | null },
  uSideRect: { value: new THREE.Vector4(0, 1, 0, 1) },
  uBox: { value: new THREE.Vector4(-0.1, 0.1, 0, 1) },
  uFlip: { value: 0 },
  uSideOn: { value: 0 },
};
function makeClothMat() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, sideUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2D uSideMap;
uniform vec4 uSideRect;
uniform vec4 uBox;
uniform float uFlip;
uniform float uSideOn;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
if (uSideOn > 0.5) {
  float tz = (uBox.y - vWPos.z) / max(uBox.y - uBox.x, 1e-4);
  if (vWPos.x < 0.0) tz = 1.0 - tz;
  if (uFlip > 0.5) tz = 1.0 - tz;
  float ty = (vWPos.y - uBox.z) / max(uBox.w - uBox.z, 1e-4);
  vec4 sc = texture2D(uSideMap, vec2(mix(uSideRect.x, uSideRect.y, tz), mix(uSideRect.z, uSideRect.w, ty)));
  float sw = smoothstep(0.55, 0.9, abs(vWNrm.x)) * sc.a;
  diffuseColor.rgb = mix(diffuseColor.rgb, sc.rgb, sw);
}`,
      );
  };
  return m;
}
const frontMat = makeClothMat();
const backMat = makeClothMat();

// ---------- UI wiring ----------
const bodyFields: [keyof BodyMeasurements, string, number, number][] = [
  ['height', 'Height', 150, 200],
  ['chest', 'Chest', 76, 140],
  ['waist', 'Waist', 60, 140],
  ['hip', 'Hip', 80, 140],
  ['upperHip', 'Upper hip', 70, 140],
  ['ribcage', 'Ribcage', 66, 130],
  ['shoulderWidth', 'Shoulders', 36, 56],
];
const bodySliders = new Map<keyof BodyMeasurements, { input: HTMLInputElement; out: HTMLElement }>();
for (const [key, label, min, max] of bodyFields) {
  const l = document.createElement('label');
  l.innerHTML = `${label}<input type="range" min="${min}" max="${max}" value="${bodyM[key]}"><output>${bodyM[key]}</output>`;
  const input = l.querySelector('input')!;
  const out = l.querySelector('output')!;
  bodySliders.set(key, { input, out });
  input.addEventListener('input', () => {
    bodyM[key] = +input.value;
    out.textContent = input.value;
  });
  // with a scan, only the height changes geometry; the other numbers just feed the fit report
  input.addEventListener('change', () => (scanRaw && key === 'height' ? rebuildScan() : rebuild()));
  $('body-controls').appendChild(l);
}
function setBodySlider(key: keyof BodyMeasurements, v: number) {
  const sl = bodySliders.get(key)!;
  const clamped = Math.min(+sl.input.max, Math.max(+sl.input.min, Math.round(v)));
  sl.input.value = String(clamped);
  sl.out.textContent = String(clamped);
  bodyM[key] = clamped;
}
const opt = (v: string, t: string) => `<option value="${v}">${t}</option>`;
$<HTMLSelectElement>('sample').innerHTML = opt('', 'Load a sample garment…') + SAMPLES.map((s) => opt(s.id, s.label)).join('');
$<HTMLSelectElement>('preset').innerHTML = PRESETS.map((p) => opt(p.id, p.label)).join('');
$<HTMLSelectElement>('size').innerHTML = SIZES.map((s, i) => opt(String(i), `${s.name} (${Math.round(s.scale * 100)}%)`)).join('');
$<HTMLSelectElement>('fabric').innerHTML = Object.entries(FABRICS).map(([k, f]) => opt(k, f.label)).join('');
$<HTMLSelectElement>('size').value = String(st.sizeIdx);

// photo slots
const thumbs = new Map<Slot, HTMLCanvasElement>();
for (const [slot, label] of SLOTS) {
  const d = document.createElement('div');
  d.className = 'slot';
  d.innerHTML = `<b>${label}</b><canvas width="144" height="144"></canvas><input type="file" accept="image/*"><button class="x" title="Remove">×</button>`;
  thumbs.set(slot, d.querySelector('canvas')!);
  d.querySelector('input')!.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    canvases[slot] = c;
    st.threshold = undefined;
    processPhotos();
  });
  d.querySelector('.x')!.addEventListener('click', () => {
    delete canvases[slot];
    processPhotos();
  });
  $('slots').appendChild(d);
}
function drawThumbs() {
  for (const [slot] of SLOTS) {
    const t = thumbs.get(slot)!;
    const ctx = t.getContext('2d')!;
    ctx.clearRect(0, 0, t.width, t.height);
    const c = canvases[slot];
    if (!c) continue;
    const k = Math.min(t.width / c.width, t.height / c.height);
    ctx.drawImage(c, (t.width - c.width * k) / 2, (t.height - c.height * k) / 2, c.width * k, c.height * k);
  }
}

$<HTMLSelectElement>('sample').addEventListener('change', (e) => {
  const id = (e.target as HTMLSelectElement).value;
  if (id) loadSample(id);
});
$<HTMLInputElement>('sideflip').addEventListener('change', (e) => {
  sideUniforms.uFlip.value = (e.target as HTMLInputElement).checked ? 1 : 0;
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
$<HTMLInputElement>('threshold').addEventListener('change', () => processPhotos());
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
  applyMode();
});
$('resim').addEventListener('click', rebuild);

function applyMode() {
  const photo = st.mode === 'photo';
  frontMat.map = photo ? texFront : null;
  backMat.map = photo ? texBack : null;
  frontMat.needsUpdate = backMat.needsUpdate = true;
  sideUniforms.uSideOn.value = photo && texSide ? 1 : 0;
  $('legend').style.display = photo ? 'none' : 'block';
}

// body scan controls
$('scan-btn').addEventListener('click', () => $<HTMLInputElement>('scan-file').click());
$<HTMLInputElement>('scan-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    status('Reading scan…');
    await setScan(await loadScanFile(f));
  } catch (err) {
    status(`Could not load the scan: ${(err as Error).message}`);
  }
});
$('scan-demo').addEventListener('click', () => void setScan(demoScanMesh()));
$('scan-rot').addEventListener('click', () => {
  scanTurns = (scanTurns + 1) % 4;
  void rebuildScan();
});
$('scan-param').addEventListener('click', () => {
  scanRaw = null;
  scanData = null;
  scanNorm = null;
  if (scanObj) scene.remove(scanObj);
  scanObj = null;
  $('scan-tools').style.display = 'none';
  $('body-note').textContent = 'Parametric body from measurements.';
  rebuild();
});

function status(t: string) {
  $('status').textContent = t;
}
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30));

async function setScan(raw: RawMesh) {
  scanRaw = raw;
  scanTurns = 0;
  await rebuildScan(true);
}

/** Normalise the scan to the chosen height, build its collision field and measure it. */
async function rebuildScan(readMeasurements = false) {
  if (!scanRaw) return;
  status('Building body collision field…');
  await nextFrame();
  const H = bodyM.height;
  scanNorm = normalizeScan(scanRaw, H, scanTurns);
  scanData = new ScanData(toSoup(scanNorm), H / 100);
  if (readMeasurements) {
    const m = scanData.measurements;
    for (const k of ['chest', 'waist', 'hip', 'shoulderWidth'] as const) if (m[k] > 0) setBodySlider(k, m[k]);
  }
  if (scanObj) scene.remove(scanObj);
  scanObj = scanMesh(scanNorm);
  $('scan-tools').style.display = 'flex';
  $('body-note').textContent =
    'Using your scan: scaled to the height below and measured automatically (you can correct the numbers). If it faces the wrong way, use Rotate 90°.';
  rebuild();
}

function scanMesh(n: NormalizedScan): THREE.Object3D {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(n.pos, 3));
  geo.setIndex(new THREE.BufferAttribute(n.idx, 1));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc89b7b, roughness: 0.8, side: THREE.DoubleSide }));
}

// ---------- garment pipeline: photos -> masks -> pattern ----------
function loadSample(id: string) {
  const def = SAMPLES.find((s) => s.id === id)!;
  st.preset = def.preset;
  st.length = getPreset(def.preset).length;
  st.threshold = undefined;
  $<HTMLSelectElement>('preset').value = st.preset;
  $<HTMLInputElement>('length').value = String(st.length);
  for (const k of ['front', 'back', 'side', 'flat'] as Slot[]) delete canvases[k];
  canvases.front = drawSample(def, 400, 'front');
  canvases.back = drawSample(def, 400, 'back');
  processPhotos();
}

function toTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function segmentCanvas(c: HTMLCanvasElement): Photo & { threshold: number; usedAlpha: boolean } {
  // work at modest resolution; the full-size image is only used as the texture
  const k = Math.min(1, 420 / Math.max(c.width, c.height));
  const w = Math.round(c.width * k);
  const h = Math.round(c.height * k);
  const tmpc = document.createElement('canvas');
  tmpc.width = w;
  tmpc.height = h;
  const ctx = tmpc.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, w, h);
  const seg = segment(ctx.getImageData(0, 0, w, h).data, w, h, { threshold: st.threshold });
  return { canvas: c, w, h, mask: seg.mask, threshold: seg.threshold, usedAlpha: seg.usedAlpha };
}

/** The side photo as an RGBA canvas whose alpha is the garment mask, so background is never projected. */
function cutOutCanvas(p: Photo): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = p.canvas.width;
  out.height = p.canvas.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(p.canvas, 0, 0);
  const m = document.createElement('canvas');
  m.width = p.w;
  m.height = p.h;
  const mctx = m.getContext('2d')!;
  const img = mctx.createImageData(p.w, p.h);
  for (let i = 0; i < p.mask.length; i++) {
    img.data[i * 4 + 3] = p.mask[i] ? 255 : 0;
  }
  mctx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(m, 0, 0, out.width, out.height);
  return out;
}

function processPhotos() {
  drawThumbs();
  photos = {};
  let usedThreshold: number | null = null;
  let alpha = false;
  for (const [slot] of SLOTS) {
    const c = canvases[slot];
    if (!c) continue;
    const r = segmentCanvas(c);
    photos[slot] = r;
    if ((slot === 'flat' || (slot === 'front' && !photos.flat)) && usedThreshold === null) {
      usedThreshold = r.threshold;
      alpha = r.usedAlpha;
    }
  }
  srcPhoto = photos.flat ?? photos.front ?? null;
  const slider = $<HTMLInputElement>('threshold');
  if (!srcPhoto) {
    pattern = null;
    if (clothMesh) scene.remove(clothMesh);
    clothMesh = null;
    cloth = null;
    status('Add a front or flat-lay photo of the garment.');
    drawEditor();
    rebuild();
    return;
  }
  srcCanvas = srcPhoto.canvas;
  if (st.threshold === undefined && usedThreshold !== null) {
    slider.value = String(Math.round(usedThreshold));
    $('threshold-out').textContent = alpha ? 'alpha' : 'auto';
  }
  pattern = buildPattern(srcPhoto.mask, srcPhoto.w, srcPhoto.h);
  if (!pattern) {
    status('Could not find a garment in this image — try the cut-out slider.');
    return;
  }
  openings = autoOpenings(pattern, getPreset(st.preset));

  // Register the other photos onto the pattern and prepare their textures.
  const src = { mask: srcPhoto.mask, w: srcPhoto.w, h: srcPhoto.h };
  const notes: string[] = [];
  const frontPhoto = photos.front ?? photos.flat!;
  let tFront: Affine;
  if (frontPhoto === srcPhoto) tFront = identity();
  else {
    const r = alignMask(src, frontPhoto, false);
    tFront = r.transform;
    notes.push(`front↔flat match ${Math.round(r.iou * 100)}%`);
  }
  hasBackPhoto = !!photos.back;
  let tBack = tFront;
  let backPhoto: Photo = frontPhoto;
  if (photos.back) {
    const r = alignMask(src, photos.back, 'auto');
    tBack = r.transform;
    backPhoto = photos.back;
    notes.push(`back match ${Math.round(r.iou * 100)}%${r.iou < 0.6 ? ' (low — does the back photo show the same garment?)' : ''}`);
  }
  uvFront = uvFor(pattern, tFront, frontPhoto);
  uvBack = uvFor(pattern, tBack, backPhoto);

  texFront?.dispose();
  texBack?.dispose();
  texSide?.dispose();
  texFront = toTexture(frontPhoto.canvas);
  texBack = backPhoto === frontPhoto ? texFront : toTexture(backPhoto.canvas);
  texSide = null;
  if (photos.side) {
    texSide = toTexture(cutOutCanvas(photos.side));
    sideUniforms.uSideMap.value = texSide;
    const bb = maskRect(photos.side);
    sideUniforms.uSideRect.value.set(bb.minX / photos.side.w, bb.maxX / photos.side.w, 1 - bb.maxY / photos.side.h, 1 - bb.minY / photos.side.h);
    notes.push('side photo projected on sides');
  }
  applyMode();
  statusNotes = notes.join(' · ');
  rebuild();
}
let statusNotes = '';

/** Pattern pixels already are the source photo's pixels. */
function identity(): Affine {
  return { m: 1, sx: 1, sy: 1, ox: 0, oy: 0, cx: 0, cy: 0 };
}

function uvFor(p: Pattern, t: Affine, photo: Photo): Float32Array {
  const N = p.pts.length / 2;
  const out = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const [qx, qy] = applyAffine(t, p.pts[i * 2], p.pts[i * 2 + 1]);
    out[i * 2] = qx / photo.w;
    out[i * 2 + 1] = 1 - qy / photo.h;
  }
  return out;
}

function maskRect(p: Photo) {
  let minX = p.w, minY = p.h, maxX = 0, maxY = 0;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++)
      if (p.mask[y * p.w + x]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x + 1);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + 1);
      }
  return { minX, minY, maxX, maxY };
}

// ---------- body + cloth ----------
function bodyMesh(b: Body): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc89b7b, roughness: 0.8 });
  const S = b.sections.filter((q) => q.y >= b.visibleYMin - 1e-6);
  const seg = 48;
  const verts: number[] = [];
  const idx: number[] = [];
  for (const s of S) {
    for (let r = 0; r <= seg; r++) {
      const t = (r / seg) * Math.PI * 2;
      verts.push(Math.sin(t) * s.a, s.y, Math.cos(t) * s.b);
    }
  }
  for (let i = 0; i < S.length - 1; i++) {
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
  bodyObj = null;
  if (clothMesh) {
    scene.remove(clothMesh);
    clothMesh.geometry.dispose();
    clothMesh = null;
  }
  cloth = null;
  if (scanObj) scene.remove(scanObj);
  if (!pattern) {
    // no garment yet: just show the body
    if (scanData && scanObj) scene.add(scanObj);
    else {
      bodyObj = bodyMesh(new Body(bodyM, 25));
      scene.add(bodyObj);
    }
    controls.target.set(0, (bodyM.height / 100) * 0.58, 0);
    return;
  }

  const preset = getPreset(st.preset);
  const fabric = FABRICS[st.fabric];
  const H = bodyM.height / 100;
  const patternH = pattern.bbox.maxY - pattern.bbox.minY;
  const metersPerPx = ((st.length / 100) * SIZES[st.sizeIdx].scale) / patternH;
  let topY = preset.anchor * H + st.offset / 100;
  // with a scan, hang tops from the scan's own shoulder line
  if (scanData && preset.anchor > 0.8) topY = scanData.shoulderLineY - 0.01 + st.offset / 100;

  let body: BodyModel;
  let sleeveWarp: ConstructorParameters<typeof Cloth>[0]['sleeveWarp'];
  const useScan = !!scanData;
  if (useScan) {
    const sd = scanData!;
    body = sd.collider(preset.hangsFromHips);
    scene.add(scanObj!);
    bodyObj = null;
    if (st.preset === 'top') {
      const torsoHalf = torsoHalfWidth(pattern, metersPerPx);
      if (torsoHalf !== null) {
        const garmentAngle = estimateArmAngle(pattern, metersPerPx, topY, sd.shoulderHalfWidth);
        sleeveWarp = {
          torsoHalf,
          jointX: sd.shoulderHalfWidth - 0.02,
          jointY: LANDMARKS.shoulder * H - 0.035,
          deltaDeg: sd.armAngle - garmentAngle,
        };
      }
    }
    $('arm-out').textContent = `scan ${Math.round(sd.armAngle)}°`;
  } else {
    const sh = new Body(bodyM, 30).sectionAt(LANDMARKS.shoulder * H);
    const arm = st.armAuto ? estimateArmAngle(pattern, metersPerPx, topY, sh.a) : st.arm;
    if (st.armAuto) {
      $<HTMLInputElement>('arm').value = String(Math.round(arm));
      $('arm-out').textContent = 'auto';
    }
    const pb = new Body(bodyM, arm, preset.hangsFromHips);
    body = pb;
    bodyObj = bodyMesh(pb);
    scene.add(bodyObj);
  }

  cloth = new Cloth({
    body,
    pattern,
    openings,
    metersPerPx,
    topY,
    holdTop: preset.holdTop,
    stiffness: fabric.stiffness,
    bend: fabric.bend,
    sleeveWarp,
  });
  cloth.settle(160);

  const n = cloth.renderMap.length;
  const N = n / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new Float32Array(n * 2);
  uv.set(uvFront, 0);
  uv.set(uvBack, N * 2);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(cloth.indices, 1));
  geo.addGroup(0, cloth.frontIndexCount, 0);
  geo.addGroup(cloth.frontIndexCount, cloth.indices.length - cloth.frontIndexCount, 1);
  clothMesh = new THREE.Mesh(geo, [frontMat, backMat]);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);
  controls.target.set(0, H * 0.58, 0);
  updateSideBox();

  status(`${cloth.count} particles · ${(cloth.indices.length / 3) | 0} triangles${statusNotes ? ' · ' + statusNotes : ''}`);
  report(body, metersPerPx, topY);
  drawEditor();
}

/** Bounds of the draped cloth, used to map the side photo onto it. */
function updateSideBox() {
  if (!cloth) return;
  let zMin = Infinity, zMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < cloth.count; i++) {
    zMin = Math.min(zMin, cloth.pos[i * 3 + 2]);
    zMax = Math.max(zMax, cloth.pos[i * 3 + 2]);
    yMin = Math.min(yMin, cloth.pos[i * 3 + 1]);
    yMax = Math.max(yMax, cloth.pos[i * 3 + 1]);
  }
  sideUniforms.uBox.value.set(zMin, zMax, yMin, yMax);
}

function report(body: BodyModel, metersPerPx: number, topY: number) {
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
        const v = k < half || hasBackPhoto ? 1 : 0.8; // without a back photo the back is a darker copy of the front
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
(window as unknown as { __app: unknown }).__app = { camera, controls, st };
