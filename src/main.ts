import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Body, BodyMeasurements, DEFAULT_BODY } from './body';
import { Cloth } from './cloth';
import { SIZE_CHART, analyseFit, recommendSize } from './fit';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171c);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 20);
camera.position.set(0, 1.2, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.1, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(2, 3, 3);
scene.add(sun);
scene.add(new THREE.GridHelper(3, 12, 0x333844, 0x252932));

const body: BodyMeasurements = { ...DEFAULT_BODY };
let sizeIdx = 1;
let mode: 'strain' | 'gap' = 'strain';
let bodyObj: THREE.Object3D | null = null;
let clothMesh: THREE.Mesh | null = null;
let cloth: Cloth | null = null;

const fields: [keyof BodyMeasurements, string, number, number][] = [
  ['height', 'Height', 150, 200],
  ['chest', 'Chest', 76, 140],
  ['waist', 'Waist', 60, 140],
  ['hip', 'Hip', 80, 140],
  ['shoulderWidth', 'Shoulders', 36, 56],
];
for (const [key, label, min, max] of fields) {
  const l = document.createElement('label');
  l.innerHTML = `${label}<input type="range" min="${min}" max="${max}" value="${body[key]}"><output>${body[key]}</output>`;
  const input = l.querySelector('input')!;
  const out = l.querySelector('output')!;
  input.addEventListener('input', () => {
    body[key] = +input.value;
    out.textContent = input.value;
  });
  input.addEventListener('change', rebuild);
  $('body-controls').appendChild(l);
}
$<HTMLSelectElement>('size').innerHTML = SIZE_CHART.map(
  (g, i) => `<option value="${i}" ${i === sizeIdx ? 'selected' : ''}>Size ${g.name} (chest ${g.chest} cm)</option>`,
).join('');
$<HTMLSelectElement>('size').addEventListener('change', (e) => {
  sizeIdx = +(e.target as HTMLSelectElement).value;
  rebuild();
});
$<HTMLSelectElement>('mode').addEventListener('change', (e) => {
  mode = (e.target as HTMLSelectElement).value as 'strain' | 'gap';
});
$('resim').addEventListener('click', rebuild);

function bodyMesh(b: Body): THREE.Object3D {
  const g = new THREE.Group();
  const S = b.sections;
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
  const mat = new THREE.MeshStandardMaterial({ color: 0xc89b7b, roughness: 0.8, side: THREE.DoubleSide });
  g.add(new THREE.Mesh(geo, mat));
  const H = b.height;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.095, 24, 16), mat);
  head.scale.set(0.95, 1.2, 1.05);
  head.position.set(0, H * 0.935, 0);
  g.add(head);
  const hipS = b.sectionAt(b.yMin + 0.01);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(hipS.a * 0.5, hipS.a * 0.3, b.yMin, 20), mat);
    leg.position.set(side * hipS.a * 0.5, b.yMin / 2, 0);
    g.add(leg);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.032, H * 0.33, 14), mat);
    const sh = b.sectionAt(b.height * 0.82);
    arm.position.set(side * (sh.a + 0.05), H * 0.82 - H * 0.16, 0);
    g.add(arm);
  }
  return g;
}

const COLD = new THREE.Color(0x3b82f6);
const NEUTRAL = new THREE.Color(0xe5e7eb);
const HOT = new THREE.Color(0xef4444);
const tmp = new THREE.Color();

function colorFor(i: number, c: Cloth): THREE.Color {
  // Value in [-1, 1]: -1 loose (blue) .. 0 neutral .. +1 tight (red)
  let v: number;
  if (mode === 'strain') v = Math.max(-1, Math.min(1, (c.strain[i] - 1) * 12));
  else v = Math.max(-1, Math.min(1, -(c.gap[i] - 1.0) * 14 + (c.gap[i] < 1.02 ? 0.5 : 0)));
  return v >= 0 ? tmp.copy(NEUTRAL).lerp(HOT, v) : tmp.copy(NEUTRAL).lerp(COLD, -v);
}

function rebuild() {
  if (bodyObj) scene.remove(bodyObj);
  if (clothMesh) {
    scene.remove(clothMesh);
    clothMesh.geometry.dispose();
  }
  const b = new Body(body);
  bodyObj = bodyMesh(b);
  scene.add(bodyObj);
  cloth = new Cloth(b, SIZE_CHART[sizeIdx]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(cloth.pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cloth.count * 3), 3));
  geo.setIndex(cloth.indices);
  clothMesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }),
  );
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);
  controls.target.set(0, b.height * 0.62, 0);
  report();
}

function report() {
  const g = SIZE_CHART[sizeIdx];
  const cls = (v: string) => (v.startsWith('too tight') ? 'v-too' : v === 'snug' ? 'v-snug' : v === 'regular' ? 'v-regular' : 'v-loose');
  $('report').innerHTML =
    '<tr><th>Area</th><th>Body</th><th>Ease</th><th>Fit</th></tr>' +
    analyseFit(body, g)
      .map(
        (f) =>
          `<tr><td>${f.region}</td><td>${f.body}</td><td>${f.ease > 0 ? '+' : ''}${f.ease.toFixed(0)}</td><td class="${cls(f.verdict)}">${f.verdict}</td></tr>`,
      )
      .join('');
  $('recs').innerHTML =
    '<tr><th>Size</th><th>Score</th></tr>' +
    recommendSize(body)
      .map((r, i) => `<tr><td>${r.garment.name}${i === 0 ? ' ★' : ''}</td><td>${r.score}/100</td></tr>`)
      .join('');
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
    const col = clothMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < cloth.count; i++) {
      const c = colorFor(i, cloth);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    (clothMesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    clothMesh.geometry.computeVertexNormals();
  }
  controls.update();
  renderer.render(scene, camera);
}

resize();
rebuild();
frame();
