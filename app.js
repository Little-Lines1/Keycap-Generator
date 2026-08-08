import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

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
  resolution: 28,
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
camera.position.set(13, 22, 15);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 90;
controls.target.set(0, -TOTAL_H / 2, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(20, 30, 15);
scene.add(key);
const rim = new THREE.DirectionalLight(0x5eead4, 0.35);
rim.position.set(-20, 10, -15);
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

// Pick a sensible default grid resolution for this specific upload:
// raster images that are already small (typical of pixel-art icons)
// get sampled 1:1 so nothing is blurred or re-aliased; large raster
// images and scale-free SVGs get the max supported detail instead.
function pickAutoResolution(nativeW, nativeH) {
  const MIN = 16, MAX = 64;
  if (nativeW && nativeH) {
    const native = Math.max(nativeW, nativeH);
    return Math.min(MAX, Math.max(MIN, native));
  }
  return MAX; // SVG / unknown native size: go for maximum detail
}

function applyAutoResolution(nativeW, nativeH) {
  const r = pickAutoResolution(nativeW, nativeH);
  state.resolution = r;
  resSlider.value = r;
  resVal.textContent = `${r} × ${r}`;
}

function openFile(file) {
  if (!file) return;
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
  const isRaster = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
    || /\.(png|jpe?g|webp)$/i.test(file.name);

  if (!isSvg && !isRaster) {
    showDzError('Only PNG, JPG, WebP or SVG files are supported');
    return;
  }

  if (isRaster) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (w !== h) { showDzError(`Image must be square (1:1) — yours is ${w}×${h}px`); return; }
        applyAutoResolution(w, h);
        state.img = img;
        dzTitle.textContent = file.name;
        dropzone.classList.remove('error');
        dropzone.classList.add('has-image');
        rebuild();
      };
      img.onerror = () => showDzError('Could not read this image');
      img.src = e.target.result;
    };
    reader.onerror = () => showDzError('Could not read this file');
    reader.readAsDataURL(file);
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
  rebuild();
});
resSlider.addEventListener('input', () => {
  state.resolution = +resSlider.value;
  resVal.textContent = `${state.resolution} × ${state.resolution}`;
  rebuild();
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
// Geometry builders
// ---------------------------------------------------------------

// Box helper: returns a Mesh positioned by CENTER coordinates (mm),
// with y = up (three.js), footprint on XZ, height on Y.
function box(sx, sy, sz, cx, cy, cz, color) {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(cx, cy, cz);
  return m;
}

// Builds the solid body (Y from yBottom..yTop) around a centered
// cross-shaped cavity, as 8 non-overlapping boxes (no CSG needed).
function crossFrameBoxes(yBottom, yTop, color) {
  const half = CAP / 2;
  const armHalfLen = CROSS_LEN / 2;   // how far each blade extends from center
  const armHalfW = CROSS_W / 2;       // blade half-thickness
  const h = yTop - yBottom;
  const cy = (yTop + yBottom) / 2;
  const meshes = [];

  // top strip (beyond +Z arm reach) and bottom strip (beyond -Z arm reach)
  meshes.push(box(CAP, h, half - armHalfLen, 0, cy, (armHalfLen + half) / 2, color));
  meshes.push(box(CAP, h, half - armHalfLen, 0, cy, -(armHalfLen + half) / 2, color));

  // left / right strips spanning the full arm band, outside the arm's X reach
  const bandZ = CROSS_LEN; // full band depth = 2*armHalfLen
  meshes.push(box(half - armHalfLen, h, bandZ, (armHalfLen + half) / 2, cy, 0, color));
  meshes.push(box(half - armHalfLen, h, bandZ, -(armHalfLen + half) / 2, cy, 0, color));

  // four quadrant fillers between the blades (upper/lower x left/right)
  const qW = armHalfLen - armHalfW; // width of filler between blade edge and arm reach
  const qZcenter = (armHalfW + armHalfLen) / 2;
  meshes.push(box(qW, h, armHalfLen - armHalfW, (armHalfW + armHalfLen) / 2, cy, qZcenter, color));
  meshes.push(box(qW, h, armHalfLen - armHalfW, (armHalfW + armHalfLen) / 2, cy, -qZcenter, color));
  meshes.push(box(qW, h, armHalfLen - armHalfW, -(armHalfW + armHalfLen) / 2, cy, qZcenter, color));
  meshes.push(box(qW, h, armHalfLen - armHalfW, -(armHalfW + armHalfLen) / 2, cy, -qZcenter, color));

  return meshes;
}

function buildKeycap() {
  const baseGroup = new THREE.Group();
  const iconGroup = new THREE.Group();

  if (!state.mask) {
    return { baseGroup, iconGroup };
  }

  const N = state.resolution;
  const cell = CAP / N;
  const half = CAP / 2;

  // determine per-pixel display colors
  let baseHex = state.baseColor, iconHex = state.iconColor;
  if (state.mode === 'color' && state._colors) {
    baseHex = averageColor(state._colors, state.mask, 0);
    iconHex = averageColor(state._colors, state.mask, 1);
    fillBase.style.background = baseHex;
    fillIcon.style.background = iconHex;
  }

  // ---- top pixel layer (Y: 0 .. PIXEL_H) ----
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const isIcon = state.mask[idx] === 1;
      const cx = -half + cell * (col + 0.5);
      const cz = -half + cell * (row + 0.5);
      const m = box(cell + 0.02, PIXEL_H, cell + 0.02, cx, PIXEL_H / 2, cz, isIcon ? iconHex : baseHex);
      (isIcon ? iconGroup : baseGroup).add(m);
    }
  }

  // ---- thin solid cap between pixel layer and stem socket ----
  const capFloorTop = PIXEL_H + SOCKET_MARGIN;
  baseGroup.add(box(CAP, SOCKET_MARGIN, CAP, 0, PIXEL_H + SOCKET_MARGIN / 2, 0, baseHex));

  // ---- body with cross socket (Y: capFloorTop .. TOTAL_H) ----
  crossFrameBoxes(capFloorTop, TOTAL_H, baseHex).forEach(m => baseGroup.add(m));

  return { baseGroup, iconGroup };
}

function rebuild() {
  if (!state.img) return;

  const { mask, colors } = sampleImageToMask(state.img, state.resolution, state.scalePct);
  state.mask = mask;
  state._colors = colors;

  if (capGroup) { scene.remove(capGroup); }
  const { baseGroup, iconGroup } = buildKeycap();
  capGroup = new THREE.Group();
  capGroup.add(baseGroup, iconGroup);
  // The icon layer sits at local Y=0..0.8, the stem socket opening at
  // the top (Y≈4.5). Flip 180° so the ICON faces the camera by default
  // instead of the stem-socket cavity (that cross-shaped "dent" you saw).
  capGroup.rotation.x = Math.PI;
  scene.add(capGroup);

  state._baseGroup = baseGroup;
  state._iconGroup = iconGroup;

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
function exportGroup(group, filename) {
  const exportScene = new THREE.Group();
  group.children.forEach(child => {
    const clone = child.clone();
    exportScene.add(clone);
  });
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
  if (!state._baseGroup) return;
  exportGroup(state._baseGroup, 'keycap-base.stl');
});
dlIconBtn.addEventListener('click', () => {
  if (!state._iconGroup) return;
  exportGroup(state._iconGroup, 'keycap-icon.stl');
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
