import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Affine, alignMask, applyAffine } from './garment/align';
import { Body, BodyMeasurements, BodyModel, DEFAULT_BODY, LANDMARKS } from './body';
import { Cloth } from './cloth';
import { FABRICS, FabricId, GarmentMeasure, SIZES, analyseFit, sizeTable } from './fit';
import { measureGarment, torsoHalfWidth } from './garment/measure';
import { Pattern, buildPattern } from './garment/pattern';
import { PRESETS, PresetId, autoOpenings, estimateArmAngle, getPreset, transferOpenings } from './garment/presets';
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
const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(2, 3, 3);
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -1.5;
sun.shadow.camera.right = 1.5;
sun.shadow.camera.top = 2;
sun.shadow.camera.bottom = -0.3;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 10;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.012;
sun.shadow.radius = 4;
scene.add(sun);
const grid = new THREE.GridHelper(3, 12, 0x333844, 0x252932);
scene.add(grid);
// studio floor that only shows shadows (high quality mode)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.32 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.visible = false;
scene.add(floor);
let envTex: THREE.Texture | null = null;

// ---------- state ----------
const bodyM: BodyMeasurements = { ...DEFAULT_BODY };
const st = {
  preset: 'top' as PresetId,
  length: 70,
  sizeIdx: 1,
  fabric: 'woven' as FabricId,
  threshold: undefined as number | undefined,
  offset: 0,
  width: 100,
  quality: 'preview' as 'preview' | 'high',
  finish: 'auto' as FinishId,
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
  /** garment bounds including thin straps that were removed from `mask` */
  fullBBox: { minX: number; minY: number; maxX: number; maxY: number };
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
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92 });
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

// ---------- fabric finishes (physically based materials) ----------
type FinishId = 'auto' | 'matte' | 'leather' | 'satin' | 'denim' | 'knit';
interface Finish {
  label: string;
  roughness: number;
  sheen: number;
  clearcoat: number;
  clearcoatRoughness: number;
  bump: 'fine' | 'grain' | 'twill' | 'knit' | null;
  bumpScale: number;
}
const FINISHES: Record<Exclude<FinishId, 'auto'>, Finish> = {
  matte: { label: 'Matte cotton / crepe', roughness: 0.88, sheen: 0.25, clearcoat: 0, clearcoatRoughness: 0.5, bump: 'fine', bumpScale: 0.5 },
  leather: { label: 'Leather / faux leather', roughness: 0.4, sheen: 0, clearcoat: 0.45, clearcoatRoughness: 0.32, bump: 'grain', bumpScale: 1.2 },
  satin: { label: 'Satin / silk', roughness: 0.28, sheen: 1, clearcoat: 0, clearcoatRoughness: 0.5, bump: null, bumpScale: 0 },
  denim: { label: 'Denim / twill', roughness: 0.9, sheen: 0.15, clearcoat: 0, clearcoatRoughness: 0.5, bump: 'twill', bumpScale: 1.2 },
  knit: { label: 'Knit / jersey', roughness: 0.95, sheen: 0.7, clearcoat: 0, clearcoatRoughness: 0.5, bump: 'knit', bumpScale: 1.4 },
};
const bumpCache = new Map<string, THREE.CanvasTexture>();
function bumpTexture(kind: NonNullable<Finish['bump']>): THREE.CanvasTexture {
  const cached = bumpCache.get(kind);
  if (cached) return cached;
  const N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, N, N);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  if (kind === 'fine') {
    const img = g.getImageData(0, 0, N, N);
    for (let i = 0; i < N * N; i++) {
      const v = 128 + (rnd() - 0.5) * 90;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    }
    g.putImageData(img, 0, 0);
  } else if (kind === 'grain') {
    // pebbled leather: soft round cells separated by darker creases
    for (let i = 0; i < 70; i++) {
      const x = rnd() * N;
      const y = rnd() * N;
      const r = 7 + rnd() * 7;
      for (const [dx, dy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) {
        const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        gr.addColorStop(0, 'rgba(235,235,235,0.9)');
        gr.addColorStop(0.75, 'rgba(150,150,150,0.5)');
        gr.addColorStop(1, 'rgba(90,90,90,0)');
        g.fillStyle = gr;
        g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
      }
    }
  } else if (kind === 'twill') {
    for (let i = -N; i < N * 2; i += 4) {
      g.strokeStyle = (i / 4) % 2 ? '#a8a8a8' : '#585858';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + N, N);
      g.stroke();
    }
  } else {
    // knit: columns of V-shaped stitches
    g.lineWidth = 3;
    for (let y = 0; y < N; y += 8) {
      for (let x = 0; x < N; x += 8) {
        g.strokeStyle = '#c4c4c4';
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + 4, y + 7);
        g.lineTo(x + 8, y);
        g.stroke();
        g.strokeStyle = '#505050';
        g.beginPath();
        g.moveTo(x, y + 8);
        g.lineTo(x + 4, y + 7);
        g.lineTo(x + 8, y + 8);
        g.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  bumpCache.set(kind, t);
  return t;
}
function currentFinish(): Finish {
  if (st.finish !== 'auto') return FINISHES[st.finish];
  return st.fabric === 'woven' ? FINISHES.matte : FINISHES.knit;
}
/** Apply the fabric finish to both panels (bump tile size ~1.2 cm in world units). */
function applyFinish() {
  const f = currentFinish();
  const hi = st.quality === 'high';
  for (const m of [frontMat, backMat]) {
    m.roughness = hi ? f.roughness : 0.92;
    m.sheen = hi ? f.sheen : 0;
    m.sheenRoughness = 0.45;
    m.sheenColor.set(0xffffff);
    m.clearcoat = hi ? f.clearcoat : 0;
    m.clearcoatRoughness = f.clearcoatRoughness;
    m.bumpMap = hi && f.bump ? bumpTexture(f.bump) : null;
    m.bumpScale = f.bumpScale;
    if (m.bumpMap) {
      const ry = Math.max(8, (st.length / 100 / 0.012) * 1.15);
      const aspect = srcPhoto ? srcPhoto.w / srcPhoto.h : 0.7;
      m.bumpMap.repeat.set(ry * aspect, ry);
    }
    m.needsUpdate = true;
  }
}

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
  processPhotos();
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
$<HTMLInputElement>('width').addEventListener('input', (e) => {
  st.width = +(e.target as HTMLInputElement).value;
  $('width-out').textContent = `${st.width}%`;
});
$<HTMLInputElement>('width').addEventListener('change', rebuild);
$('fitme').addEventListener('click', () => {
  if (!lastFit) return;
  const f = FABRICS[st.fabric];
  const targetEase = 6 - 40 * f.stretch; // cm; stretchy fabrics are cut smaller than the body
  const row = lastFit.chest !== null ? ['chest', lastFit.chest, bodyM.chest] : lastFit.hip !== null ? ['hip', lastFit.hip, bodyM.hip] : null;
  if (!row) return;
  const k = ((row[2] as number) + targetEase) / ((row[1] as number) / (st.width / 100));
  st.width = Math.round(Math.min(170, Math.max(70, k * 100)));
  $<HTMLInputElement>('width').value = String(st.width);
  $('width-out').textContent = `${st.width}%`;
  rebuild();
});
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

$<HTMLSelectElement>('finish').innerHTML =
  opt('auto', 'Auto (from fabric)') + Object.entries(FINISHES).map(([k, f]) => opt(k, f.label)).join('');
$<HTMLSelectElement>('finish').addEventListener('change', (e) => {
  st.finish = (e.target as HTMLSelectElement).value as FinishId;
  applyFinish();
});
$<HTMLSelectElement>('quality').addEventListener('change', async (e) => {
  st.quality = (e.target as HTMLSelectElement).value as 'preview' | 'high';
  applyQuality();
  processPhotos(); // re-cut and re-mesh at the new resolution
});
$('dl-png').addEventListener('click', () => void exportPNG());
$('dl-glb').addEventListener('click', () => void exportGLB());

function applyQuality() {
  const hi = st.quality === 'high';
  renderer.setPixelRatio(hi ? 2 : devicePixelRatio);
  renderer.shadowMap.enabled = hi;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = hi ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.05;
  if (hi && !envTex) {
    const pm = new THREE.PMREMGenerator(renderer);
    envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  }
  scene.environment = hi ? envTex : null;
  scene.environmentIntensity = 0.55;
  scene.background = new THREE.Color(hi ? 0xe4e1dc : 0x15171c);
  hemi.intensity = hi ? 0.2 : 1.2;
  sun.intensity = hi ? 2.4 : 1.3;
  sun.position.set(hi ? 2.4 : 2, hi ? 3.4 : 3, hi ? 2.6 : 3);
  sun.castShadow = hi;
  grid.visible = !hi;
  floor.visible = hi;
  $('legend').style.color = hi ? '#333' : '#c4c9d6';
  $('status').style.color = hi ? '#333' : '#c4c9d6';
  applyFinish();
  resize();
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

/** Render the current view at 3000 px tall and save it. */
async function exportPNG() {
  const size = renderer.getSize(new THREE.Vector2());
  const ratio = renderer.getPixelRatio();
  const H = 3000;
  const W = Math.round(H * camera.aspect);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setPixelRatio(ratio);
  renderer.setSize(size.x, size.y, true);
  download(url, 'cloth-render.png');
}

async function exportGLB() {
  const root = new THREE.Group();
  for (const o of [clothMesh, bodyObj, scanObj]) if (o) root.add(o.clone());
  const buf = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
  download(URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' })), 'cloth-on-body.glb');
}

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
  const m = new THREE.Mesh(geo, skin(THREE.DoubleSide));
  m.castShadow = m.receiveShadow = true;
  return m;
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

/**
 * Paint the garment's edge colours outwards over the backdrop (and over the anti-aliased rim), so
 * texture lookups that land just outside the cut-out (photos never register perfectly) pick up
 * garment colour instead of a pale halo.
 */
function bleedEdges(p: Photo, radius = 120): HTMLCanvasElement {
  const W = p.canvas.width;
  const H = p.canvas.height;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(p.canvas, 0, 0);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // full-resolution mask, shrunk by a few pixels to drop the blended rim
  const filled = new Uint8Array(W * H);
  const sx = p.w / W;
  const sy = p.h / H;
  for (let y = 0; y < H; y++) {
    const my = Math.min(p.h - 1, Math.floor(y * sy)) * p.w;
    for (let x = 0; x < W; x++) filled[y * W + x] = p.mask[my + Math.min(p.w - 1, Math.floor(x * sx))];
  }
  const rim = Math.max(2, Math.round(W / 220));
  let cur = filled;
  for (let k = 0; k < rim; k++) {
    const next = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        next[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W] ? 1 : 0;
      }
    cur = next;
  }
  let frontier: number[] = [];
  for (let i = 0; i < cur.length; i++) {
    if (!cur[i]) continue;
    const x = i % W;
    const y = (i / W) | 0;
    if ((x > 0 && !cur[i - 1]) || (x < W - 1 && !cur[i + 1]) || (y > 0 && !cur[i - W]) || (y < H - 1 && !cur[i + W])) frontier.push(i);
  }
  for (let r = 0; r < radius && frontier.length; r++) {
    const nextFrontier: number[] = [];
    for (const i of frontier) {
      const x = i % W;
      const y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || cur[j]) continue;
        cur[j] = 1;
        d[j * 4] = d[i * 4];
        d[j * 4 + 1] = d[i * 4 + 1];
        d[j * 4 + 2] = d[i * 4 + 2];
        nextFrontier.push(j);
      }
    }
    frontier = nextFrontier;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function toTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function segmentCanvas(c: HTMLCanvasElement): Photo & { threshold: number; usedAlpha: boolean } {
  // work at modest resolution; the full-size image is only used as the texture
  const res = st.quality === 'high' ? HIGH.res : 420;
  const k = Math.min(1, res / Math.max(c.width, c.height));
  const w = Math.round(c.width * k);
  const h = Math.round(c.height * k);
  const tmpc = document.createElement('canvas');
  tmpc.width = w;
  tmpc.height = h;
  const ctx = tmpc.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, w, h);
  const thin = getPreset(st.preset).id === 'strap' ? Math.max(4, Math.round(0.03 * Math.max(w, h))) : 0;
  const seg = segment(ctx.getImageData(0, 0, w, h).data, w, h, { threshold: st.threshold, removeThinBelow: thin, erode: Math.max(3, Math.round(Math.max(w, h) / 140)) });
  const full = maskRect({ canvas: c, w, h, mask: seg.fullMask, fullBBox: { minX: 0, minY: 0, maxX: w, maxY: h } });
  return { canvas: c, w, h, mask: seg.mask, fullBBox: full, threshold: seg.threshold, usedAlpha: seg.usedAlpha };
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
  pattern = buildPattern(srcPhoto.mask, srcPhoto.w, srcPhoto.h, st.quality === 'high' ? HIGH.cells : 44);
  if (pattern) pattern.fullBBox = srcPhoto.fullBBox;
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
  texFront = toTexture(bleedEdges(frontPhoto));
  texBack = backPhoto === frontPhoto ? texFront : toTexture(bleedEdges(backPhoto));
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
/** high quality: steps of simulation still to run, and whether the cloth is frozen afterwards */
let settleLeft = 0;
let frozen = false;
const HIGH = { res: 900, cells: 110, steps: 90, iters: 14, perFrame: 4 };
let lastFit: GarmentMeasure | null = null;

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
function skin(side: THREE.Side = THREE.FrontSide) {
  return new THREE.MeshPhysicalMaterial({ color: 0xc89b7b, roughness: 0.58, sheen: 0.35, sheenColor: new THREE.Color(0xffb8a0), sheenRoughness: 0.6, side });
}

function bodyMesh(b: Body, hi = false): THREE.Object3D {
  const g = new THREE.Group();
  const mat = skin();
  let S = b.sections.filter((q) => q.y >= b.visibleYMin - 1e-6);
  if (hi) {
    S = [];
    for (let i = 0; i < 260; i++) S.push(b.sectionAt(b.visibleYMin + ((b.yMax - b.visibleYMin) * i) / 259));
  }
  const seg = hi ? 112 : 48;
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
  g.add(new THREE.Mesh(geo, skin(THREE.DoubleSide)));
  for (const c of b.capsules) {
    const a = new THREE.Vector3(...c.a);
    const e = new THREE.Vector3(...c.b);
    const len = a.distanceTo(e);
    if (len < 1e-4) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(c.ra * 0.95, hi ? 64 : 24, hi ? 40 : 16), mat);
      head.scale.set(0.92, 1.15, 1);
      head.position.copy(a);
      g.add(head);
      continue;
    }
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.rb, c.ra, len, hi ? 56 : 20, hi ? 24 : 1), mat);
    mesh.position.copy(a).add(e).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.clone().sub(a).normalize());
    g.add(mesh);
    for (const [pt, r] of [[a, c.ra], [e, c.rb]] as const) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(r, hi ? 40 : 16, hi ? 28 : 12), mat);
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
      bodyObj = bodyMesh(new Body(bodyM, 25), st.quality === 'high');
      scene.add(bodyObj);
    }
    controls.target.set(0, (bodyM.height / 100) * 0.58, 0);
    return;
  }

  const preset = getPreset(st.preset);
  const fabric = FABRICS[st.fabric];
  const H = bodyM.height / 100;
  const patternH = pattern.fullBBox.maxY - pattern.fullBBox.minY;
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
    bodyObj = bodyMesh(pb, st.quality === 'high');
    bodyObj.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = o.receiveShadow = true) : 0));
    scene.add(bodyObj);
  }

  const clothParams = (pat: Pattern, open: Uint8Array) => ({
    body,
    pattern: pat,
    openings: open,
    metersPerPx,
    topY,
    holdTop: preset.holdTop,
    stiffness: fabric.stiffness,
    bend: fabric.bend,
    sleeveWarp,
    widthScale: st.width / 100,
  });
  cloth = new Cloth(clothParams(pattern, openings));
  if (st.quality === 'high' && srcPhoto) {
    // drape a coarse version first (it converges to the right length quickly), then give the fine
    // mesh that shape and only simulate it long enough to develop wrinkles
    const coarsePattern = buildPattern(srcPhoto.mask, srcPhoto.w, srcPhoto.h, 44);
    if (coarsePattern) {
      coarsePattern.fullBBox = srcPhoto.fullBBox;
      const coarse = new Cloth(clothParams(coarsePattern, transferOpenings(pattern, openings, coarsePattern)));
      coarse.settle(180);
      cloth.adoptPose(coarse);
    }
    settleLeft = HIGH.steps;
    frozen = false;
  } else {
    cloth.settle(160);
    settleLeft = 0;
    frozen = false;
  }

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
  clothMesh.castShadow = clothMesh.receiveShadow = true;
  scene.add(clothMesh);
  applyFinish();
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
  const m = measureGarment(pattern, body, metersPerPx, topY, FABRICS[st.fabric].stretch, st.preset === 'top', st.width / 100);
  lastFit = m;
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

  // what if it were another size? (the photo scaled by each size factor)
  const patternH = pattern.fullBBox.maxY - pattern.fullBBox.minY;
  const table = sizeTable(bodyM, (scale) =>
    measureGarment(pattern!, body, ((st.length / 100) * scale) / patternH, topY, FABRICS[st.fabric].stretch, st.preset === 'top'),
  );
  const best = Math.max(...table.map((r) => r.score));
  const ease = (r: (typeof table)[number], k: string) => {
    const f = r.fits.find((x) => x.region === k);
    return f ? `${f.ease > 0 ? '+' : ''}${f.ease.toFixed(0)}` : '–';
  };
  $('sizes').innerHTML =
    '<tr><th>Size</th><th>Chest</th><th>Waist</th><th>Hip</th><th>Fit</th></tr>' +
    table
      .map(
        (r) =>
          `<tr${r.score === best && best > 0 ? ' style="font-weight:600"' : ''}><td>${r.name}${r.score === best && best > 0 ? ' ★' : ''}</td><td>${ease(r, 'chest')}</td><td>${ease(r, 'waist')}</td><td>${ease(r, 'hip')}</td><td class="${cls(r.worst)}">${r.worst}</td></tr>`,
      )
      .join('');
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

let lastMode = st.mode;
function frame() {
  requestAnimationFrame(frame);
  let simulated = true;
  if (cloth && clothMesh) {
    if (settleLeft > 0) {
      for (let i = 0; i < HIGH.perFrame && settleLeft > 0; i++, settleLeft--) cloth.step(1 / 60, HIGH.iters);
      status(`High quality: draping… ${Math.round(100 * (1 - settleLeft / HIGH.steps))}%`);
      if (settleLeft === 0) {
        cloth.relax(60);
        frozen = true;
        status(`High quality: ${cloth.count} particles · ${(cloth.indices.length / 3) | 0} triangles${statusNotes ? ' · ' + statusNotes : ''}`);
      }
    } else if (!frozen) cloth.step();
    else simulated = lastMode !== st.mode ? true : false;
    lastMode = st.mode;
  }
  if (cloth && clothMesh && (simulated || !frozen)) {
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
(window as unknown as { __app: unknown }).__app = { camera, controls, st, get cloth() { return cloth; }, get pattern() { return pattern; }, get texFront() { return texFront; }, get texBack() { return texBack; } };
