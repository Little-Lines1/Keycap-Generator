import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ---------------------------------------------------------------
   Keycap Forge
   Generates a flat G20-profile keycap (16.3 x 16.3 x 4.5mm) with
   a two-color pixel-art icon fused into the top face, oriented
   flat-side-down (Z=0) so it prints without supports.
   --------------------------------------------------------------- */

// ---- Fixed physical spec (Stream Deck-style flat keycap) ----
const CAP = 16.3;              // footprint, mm
const TOTAL_H = 4.5;           // total keycap height, mm
const PIXEL_H = 0.8;           // thickness of the icon/top pixel layer, mm
const SOCKET_MARGIN = 0.2;     // solid material kept above the pixel layer, mm
const CROSS_LEN = 4.0;         // MX stem cross overall span, mm
const CROSS_W = 1.3;           // MX stem cross blade width, mm
const WALL_INSET = 0.15;       // tiny inset so pixel layer + body don't z-fight visually

// ---- State ----
const state = {
  img: null,
  scalePct: 70,
  resolution: 64,
  mode: 'bw',
  baseColor: '#111214',
  iconColor: '#e9e8e4',
  mask: null,       // Uint8Array, 1 = icon pixel
};

// ---- DOM ----
const dropzone = document.getElementById('dropzone');
const dzTitle = document.getElementById('dz-title');
const fileInput = document.getElementById('file-input');
const scaleSlider = document.getElementById('scale');
const scaleVal = document.getElementById('scale-val');
const resSlider = document.getElementById('resolution');
const resVal = document.getElementById('res-val');
const seg = document.querySelectorAll('.seg button');
const colorBase = document.getElementById('color-base');
const colorIcon = document.getElementById('color-icon');
const fillBase = document.getElementById('fill-base');
const fillIcon = document.getElementById('fill-icon');
const dlIconBtn = document.getElementById('dl-icon');
const dlBaseBtn = document.getElementById('dl-base');
const dlPresetBtn = document.getElementById('dl-preset');
const uploadError = document.getElementById('upload-error');
const emptyState = document.getElementById('empty-state');
const viewerHint = document.getElementById('viewer-hint');

// ---- Three.js setup ----
const wrap = document.getElementById('canvas-wrap');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
camera.position.set(13, -22, 15);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 90;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(20, -30, 15);
scene.add(key);
const rim = new THREE.DirectionalLight(0x5eead4, 0.35);
rim.position.set(-20, -10, -15);
scene.add(rim);

let capGroup = null; // holds current preview meshes

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------
// Image handling
// ---------------------------------------------------------------
function showDzError(msg) {
  dzTitle.textContent = msg;
  dropzone.classList.remove('has-image');
  dropzone.classList.add('error');
}

// SVG is scale-free, so grid detail is always fixed at maximum (64) —
// see openFile() below. No auto-detection needed for a vector source.

function openFile(file) {
  if (!file) return;
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');

  if (!isSvg) {
    showDzError('Only .svg files are supported');
    return;
  }

  // SVG path — parse as text first so we can check the declared
  // viewBox/width/height before ever rasterizing it.
  const textReader = new FileReader();
  textReader.onload = (e) => {
    const svgText = e.target.result;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (svgEl.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      showDzError('Could not read this SVG'); return;
    }

    let w, h;
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/).map(Number);
      w = parts[2]; h = parts[3];
    } else {
      w = parseFloat(svgEl.getAttribute('width'));
      h = parseFloat(svgEl.getAttribute('height'));
    }
    if (!w || !h || Math.abs(w / h - 1) > 0.05) {
      showDzError('SVG must be square (1:1)'); return;
    }

    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // SVG is vector/scale-free — always sample at max grid detail,
      // regardless of whatever the rasterized img.naturalWidth reports
      // (that reflects the viewBox's own coordinate units, not real
      // resolution, and would otherwise wrongly tank the detail level).
      state.resolution = 64;
      resSlider.value = 64;
      resVal.textContent = '64 × 64';
      state.img = img;
      dzTitle.textContent = file.name;
      dropzone.classList.remove('error');
      dropzone.classList.add('has-image');
      rebuild();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => showDzError('Could not load this SVG');
    img.src = url;
  };
  textReader.onerror = () => showDzError('Could not read this file');
  textReader.readAsText(file);
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => openFile(e.target.files[0]));
['dragenter', 'dragover'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => openFile(e.dataTransfer.files[0]));

scaleSlider.addEventListener('input', () => {
  state.scalePct = +scaleSlider.value;
  scaleVal.textContent = state.scalePct + '%';
  scheduleRebuild();
});
resSlider.addEventListener('input', () => {
  state.resolution = +resSlider.value;
  resVal.textContent = `${state.resolution} × ${state.resolution}`;
  scheduleRebuild();
});
seg.forEach(btn => btn.addEventListener('click', () => {
  seg.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.mode = btn.dataset.mode;
  rebuild();
}));
colorBase.addEventListener('input', () => { state.baseColor = colorBase.value; fillBase.style.background = state.baseColor; rebuild(); });
colorIcon.addEventListener('input', () => { state.iconColor = colorIcon.value; fillIcon.style.background = state.iconColor; rebuild(); });

// ---------------------------------------------------------------
// Sample the uploaded image into an N x N icon/base pixel mask
// ---------------------------------------------------------------
function sampleImageToMask(img, N, scalePct) {
  const off = document.createElement('canvas');
  off.width = N; off.height = N;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, N, N);

  // draw the icon centered, scaled to scalePct of the grid
  const scale = scalePct / 100;
  const drawSize = N * scale;
  const offset = (N - drawSize) / 2;
  ctx.drawImage(img, offset, offset, drawSize, drawSize);

  const data = ctx.getImageData(0, 0, N, N).data;

  // detect if the image actually carries useful alpha info
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }

  const mask = new Uint8Array(N * N);
  const colors = []; // sampled rgb per icon pixel, for "uploaded colors" mode

  if (hasAlpha) {
    for (let p = 0; p < N * N; p++) {
      const a = data[p * 4 + 3];
      mask[p] = a > 96 ? 1 : 0;
      colors.push([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
    }
  } else {
    // no usable alpha: treat the four corners as "background" and
    // flag pixels that differ a lot from it as the icon
    const corners = [0, N - 1, (N - 1) * N, N * N - 1];
    let br = 0, bg = 0, bb = 0;
    corners.forEach(c => { br += data[c * 4]; bg += data[c * 4 + 1]; bb += data[c * 4 + 2]; });
    br /= 4; bg /= 4; bb /= 4;

    for (let p = 0; p < N * N; p++) {
      const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
      const dist = Math.sqrt((r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2);
      mask[p] = dist > 40 ? 1 : 0;
      colors.push([r, g, b]);
    }
  }

  return { mask, colors, N };
}

function averageColor(colors, mask, want) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === want) { r += colors[i][0]; g += colors[i][1]; b += colors[i][2]; n++; }
  }
  if (!n) return want ? '#e9e8e4' : '#111214';
  const toHex = v => Math.round(v).toString(16).padStart(2, '0');
  return `#${toHex(r / n)}${toHex(g / n)}${toHex(b / n)}`;
}

// ---------------------------------------------------------------
// Box helper: returns a BufferGeometry translated to CENTER coordinates
// (mm) — only used at export time now (see exportMeshFromBoxes below).
function boxGeom(sx, sy, sz, cx, cy, cz) {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  geo.translate(cx, cy, cz);
  return geo;
}

// Box descriptor: cheap {sx,sy,sz,cx,cy,cz} object (mm) — cheap to
// generate by the thousands. Real geometry is only built from these
// where it's actually needed (instanced preview, or STL export).
function boxDesc(sx, sy, sz, cx, cy, cz) {
  return { sx, sy, sz, cx, cy, cz };
}

// One shared unit cube, reused (scaled per-instance) for every pixel in
// the live preview — this is what makes high detail levels fast: no new
// geometry is allocated per pixel, just a transform matrix.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

function instancedPreview(boxes, color) {
  const group = new THREE.Group();
  if (!boxes.length) return group;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  const inst = new THREE.InstancedMesh(UNIT_BOX, mat, boxes.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  boxes.forEach((b, i) => {
    m.compose(new THREE.Vector3(b.cx, b.cy, b.cz), q, new THREE.Vector3(b.sx, b.sy, b.sz));
    inst.setMatrixAt(i, m);
  });
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);
  return group;
}

// Turns box descriptors into ONE real, mergeable mesh — only called at
// STL export time (a rare, one-off action), never during live preview.
function exportMeshFromBoxes(boxes) {
  const geoms = boxes.map(b => boxGeom(b.sx, b.sy, b.sz, b.cx, b.cy, b.cz));
  const merged = mergeGeometries(geoms, false);
  return new THREE.Mesh(merged, new THREE.MeshStandardMaterial());
}

// Builds the solid body (Y from yBottom..yTop) around a centered
// cross-shaped cavity, as 8 non-overlapping boxes (no CSG needed).
function crossFrameBoxes(yBottom, yTop) {
  const half = CAP / 2;
  const armHalfLen = CROSS_LEN / 2;   // how far each blade extends from center
  const armHalfW = CROSS_W / 2;       // blade half-thickness
  const h = yTop - yBottom;
  const cy = (yTop + yBottom) / 2;
  const b = [];

  b.push(boxDesc(CAP, h, half - armHalfLen, 0, cy, (armHalfLen + half) / 2));
  b.push(boxDesc(CAP, h, half - armHalfLen, 0, cy, -(armHalfLen + half) / 2));

  const bandZ = CROSS_LEN;
  b.push(boxDesc(half - armHalfLen, h, bandZ, (armHalfLen + half) / 2, cy, 0));
  b.push(boxDesc(half - armHalfLen, h, bandZ, -(armHalfLen + half) / 2, cy, 0));

  const qW = armHalfLen - armHalfW;
  const qZcenter = (armHalfW + armHalfLen) / 2;
  b.push(boxDesc(qW, h, armHalfLen - armHalfW, (armHalfW + armHalfLen) / 2, cy, qZcenter));
  b.push(boxDesc(qW, h, armHalfLen - armHalfW, (armHalfW + armHalfLen) / 2, cy, -qZcenter));
  b.push(boxDesc(qW, h, armHalfLen - armHalfW, -(armHalfW + armHalfLen) / 2, cy, qZcenter));
  b.push(boxDesc(qW, h, armHalfLen - armHalfW, -(armHalfW + armHalfLen) / 2, cy, -qZcenter));

  return b;
}

function buildKeycap() {
  if (!state.mask) {
    return { baseBoxes: [], iconBoxes: [], baseHex: state.baseColor, iconHex: state.iconColor };
  }

  const N = state.resolution;
  const cell = CAP / N;
  const half = CAP / 2;

  let baseHex = state.baseColor, iconHex = state.iconColor;
  if (state.mode === 'color' && state._colors) {
    baseHex = averageColor(state._colors, state.mask, 0);
    iconHex = averageColor(state._colors, state.mask, 1);
    fillBase.style.background = baseHex;
    fillIcon.style.background = iconHex;
  }

  const baseBoxes = [];
  const iconBoxes = [];

  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const isIcon = state.mask[idx] === 1;
      const cx = -half + cell * (col + 0.5);
      const cz = -half + cell * (row + 0.5);
      const d = boxDesc(cell + 0.02, PIXEL_H, cell + 0.02, cx, PIXEL_H / 2, cz);
      (isIcon ? iconBoxes : baseBoxes).push(d);
    }
  }

  const capFloorTop = PIXEL_H + SOCKET_MARGIN;
  baseBoxes.push(boxDesc(CAP, SOCKET_MARGIN, CAP, 0, PIXEL_H + SOCKET_MARGIN / 2, 0));
  baseBoxes.push(...crossFrameBoxes(capFloorTop, TOTAL_H));

  return { baseBoxes, iconBoxes, baseHex, iconHex };
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
}

function rebuild() {
  if (!state.img) return;

  const { mask, colors } = sampleImageToMask(state.img, state.resolution, state.scalePct);
  state.mask = mask;
  state._colors = colors;

  if (capGroup) { scene.remove(capGroup); }
  const { baseBoxes, iconBoxes, baseHex, iconHex } = buildKeycap();
  const baseGroup = instancedPreview(baseBoxes, baseHex);
  const iconGroup = instancedPreview(iconBoxes, iconHex);
  capGroup = new THREE.Group();
  capGroup.add(baseGroup, iconGroup);
  // The icon layer sits at local Y=0..0.8, the stem socket opening at
  // the top (Y≈4.5). Flip 180° so the ICON faces the camera by default
  // instead of the stem-socket cavity (that cross-shaped "dent" you saw).
  // Don't rotate the model to reveal the icon face — flipping a flat
  // panel 180° about an in-plane axis mirrors whatever's printed on it.
  // Instead the camera itself sits below, looking up at the icon
  // (Y=0 face), matching the actual printed-face-down orientation
  // without ever touching the geometry.
  capGroup.rotation.x = 0;
  scene.add(capGroup);

  state._baseBoxes = baseBoxes;
  state._iconBoxes = iconBoxes;

  emptyState.style.display = 'none';
  viewerHint.style.display = 'block';
  dlIconBtn.disabled = false;
  dlBaseBtn.disabled = false;
  dlPresetBtn.disabled = false;
}

// ---------------------------------------------------------------
// STL export
// Model is authored with Y-up, flat face at Y=0. For a standard
// STL/printer convention (Z-up, flat face on the bed at Z=0), we
// rotate -90° about X on export only, so downloaded files already
// sit flat-side-down with no reorientation needed in the slicer.
// ---------------------------------------------------------------
function exportBoxes(boxes, filename) {
  const mesh = exportMeshFromBoxes(boxes);
  const exportScene = new THREE.Group();
  exportScene.add(mesh);
  exportScene.rotation.x = Math.PI / 2;
  exportScene.updateMatrixWorld(true);

  const exporter = new STLExporter();
  const stlString = exporter.parse(exportScene, { binary: false });
  const blob = new Blob([stlString], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

dlBaseBtn.addEventListener('click', () => {
  if (!state._baseBoxes || !state._baseBoxes.length) return;
  exportBoxes(state._baseBoxes, 'keycap-base.stl');
});
dlIconBtn.addEventListener('click', () => {
  if (!state._iconBoxes || !state._iconBoxes.length) return;
  exportBoxes(state._iconBoxes, 'keycap-icon.stl');
});

// ---------------------------------------------------------------
// Bambu Studio process preset — low infill, few walls, small part
// defaults, so both STLs slice fast and light on filament.
// Import in Bambu Studio via: Process settings → the wrench icon →
// Import preset, then select this file.
// ---------------------------------------------------------------
function buildPresetJSON() {
  return {
    name: "Keycap Forge - low material",
    inherits: "0.20mm Standard @BBL X1C",
    layer_height: "0.2",
    wall_loops: "2",
    sparse_infill_density: "8%",
    sparse_infill_pattern: "grid",
    top_shell_layers: "3",
    bottom_shell_layers: "2",
    ironing_type: "no ironing",
    from: "User"
  };
}

dlPresetBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildPresetJSON(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'keycap-print-settings.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});
