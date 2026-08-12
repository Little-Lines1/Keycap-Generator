import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/* ---------------------------------------------------------------
   Keycap Forge
   Generates flat G20-profile keycaps (16.3 x 16.3 x 4.5mm) with a
   multi-color pixel-art icon fused into the top face, oriented flat-
   side-down so they print without supports. Exports each as one
   multi-color 3MF (base + icon colors as separate colored objects)
   that Bambu Studio reads natively. Supports batch upload — every
   uploaded icon gets its own job with its own settings.
   --------------------------------------------------------------- */

const CAP = 16.3;
const TOTAL_H = 4.5;
const PIXEL_H = 0.8;
const SOCKET_MARGIN = 0.2;
const CROSS_LEN = 4.0;
const CROSS_W = 1.3;
const BASE_COLOR = '#000000'; // keycap body is always black, by design
const MAX_JOBS = 15;

// ---- Batch state: one job per uploaded icon ----
let jobs = [];
let activeId = null;
let nextId = 1;

function activeJob() {
  return jobs.find(j => j.id === activeId) || null;
}
function makeJob(file, img) {
  return {
    id: nextId++,
    name: file.name,
    img,
    scalePct: 70,
    resolution: 400,
    mode: 'color',
    mask: null,
    _colors: null,
    _groups: null,
  };
}

// ---- DOM ----
const dropzone = document.getElementById('dropzone');
const dzTitle = document.getElementById('dz-title');
const fileInput = document.getElementById('file-input');
const scaleSlider = document.getElementById('scale');
const scaleVal = document.getElementById('scale-val');
const resSlider = document.getElementById('resolution');
const resVal = document.getElementById('res-val');
const seg = document.querySelectorAll('.seg button');
const darkIconNote = document.getElementById('dark-icon-note');
const dl3mfBtn = document.getElementById('dl-3mf');
const dlAllBtn = document.getElementById('dl-all');
const emptyState = document.getElementById('empty-state');
const viewerHint = document.getElementById('viewer-hint');
const jobListEl = document.getElementById('job-list');
const settingsPanel = document.getElementById('settings-panel');

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
controls.target.set(0, TOTAL_H / 2, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(20, 30, 15);
scene.add(key);
const rim = new THREE.DirectionalLight(0x5eead4, 0.35);
rim.position.set(-20, 10, -15);
scene.add(rim);

let capGroup = null;

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
// Job list UI
// ---------------------------------------------------------------
function renderJobList() {
  jobListEl.innerHTML = '';
  if (!jobs.length) { jobListEl.style.display = 'none'; return; }
  jobListEl.style.display = 'flex';

  jobs.forEach(job => {
    const row = document.createElement('div');
    row.className = 'job-row' + (job.id === activeId ? ' active' : '');
    row.innerHTML = `
      <span class="job-name">${job.name}</span>
      <button class="job-remove" title="Remove">×</button>
    `;
    row.querySelector('.job-name').addEventListener('click', () => selectJob(job.id));
    row.querySelector('.job-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeJob(job.id);
    });
    jobListEl.appendChild(row);
  });
}

function selectJob(id) {
  activeId = id;
  const job = activeJob();
  if (!job) return;
  scaleSlider.value = job.scalePct;
  scaleVal.textContent = job.scalePct + '%';
  resSlider.value = job.resolution;
  resVal.textContent = `${job.resolution} × ${job.resolution}`;
  seg.forEach(b => b.classList.toggle('active', b.dataset.mode === job.mode));
  renderJobList();
  rebuild();
}

function removeJob(id) {
  jobs = jobs.filter(j => j.id !== id);
  if (activeId === id) activeId = jobs.length ? jobs[0].id : null;
  renderJobList();
  if (activeId) {
    selectJob(activeId);
  } else {
    if (capGroup) { scene.remove(capGroup); capGroup = null; }
    settingsPanel.style.display = 'none';
    emptyState.style.display = 'flex';
    viewerHint.style.display = 'none';
    dl3mfBtn.disabled = true;
    dlAllBtn.disabled = true;
    dzTitle.textContent = 'Drop image or click to upload';
    dropzone.classList.remove('has-image', 'error');
  }
}

// ---------------------------------------------------------------
// Image handling — SVG only, any aspect ratio (auto-centered/padded
// into a square). Multiple files at once, up to MAX_JOBS.
// ---------------------------------------------------------------
function showDzError(msg) {
  dzTitle.textContent = msg;
  dropzone.classList.remove('has-image');
  dropzone.classList.add('error');
}

function openFiles(fileList) {
  const files = Array.from(fileList || []).slice(0, MAX_JOBS - jobs.length);
  if (!files.length) return;
  files.forEach(openFile);
}

function openFile(file) {
  if (!file) return;
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
  if (!isSvg) { showDzError('Only .svg files are supported'); return; }
  if (jobs.length >= MAX_JOBS) { showDzError(`Max ${MAX_JOBS} icons at once`); return; }

  const textReader = new FileReader();
  textReader.onload = (e) => {
    const svgText = e.target.result;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (svgEl.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      showDzError('Could not read this SVG'); return;
    }

    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const job = makeJob(file, img);
      jobs.push(job);
      dropzone.classList.remove('error');
      dropzone.classList.add('has-image');
      dzTitle.textContent = jobs.length === 1 ? file.name : `${jobs.length} icons loaded`;
      settingsPanel.style.display = 'block';
      dlAllBtn.disabled = jobs.length < 1;
      selectJob(job.id);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => showDzError('Could not load this SVG');
    img.src = url;
  };
  textReader.onerror = () => showDzError('Could not read this file');
  textReader.readAsText(file);
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  openFiles(e.target.files);
  fileInput.value = ''; // reset so selecting the same/another file again still fires 'change'
});
['dragenter', 'dragover'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => openFiles(e.dataTransfer.files));

scaleSlider.addEventListener('input', () => {
  const job = activeJob(); if (!job) return;
  job.scalePct = +scaleSlider.value;
  scaleVal.textContent = job.scalePct + '%';
  scheduleRebuild();
});
resSlider.addEventListener('input', () => {
  const job = activeJob(); if (!job) return;
  job.resolution = +resSlider.value;
  resVal.textContent = `${job.resolution} × ${job.resolution}`;
  scheduleRebuild();
});
seg.forEach(btn => btn.addEventListener('click', () => {
  const job = activeJob(); if (!job) return;
  seg.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  job.mode = btn.dataset.mode;
  rebuild();
}));

// ---------------------------------------------------------------
// Sample the uploaded image into an N x N icon/base pixel mask.
// Non-square sources are fit ("contain") and centered on both axes
// instead of being stretched or rejected.
// ---------------------------------------------------------------
function sampleImageToMask(img, N, scalePct) {
  const off = document.createElement('canvas');
  off.width = N; off.height = N;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, N, N);

  const srcW = img.naturalWidth || img.width || 1;
  const srcH = img.naturalHeight || img.height || 1;
  const targetBox = N * (scalePct / 100);
  const fitScale = Math.min(targetBox / srcW, targetBox / srcH);
  const drawW = srcW * fitScale;
  const drawH = srcH * fitScale;
  const offsetX = (N - drawW) / 2;
  const offsetY = (N - drawH) / 2;
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

  const data = ctx.getImageData(0, 0, N, N).data;

  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }

  const mask = new Uint8Array(N * N);
  const colors = [];

  if (hasAlpha) {
    for (let p = 0; p < N * N; p++) {
      const a = data[p * 4 + 3];
      mask[p] = a > 96 ? 1 : 0;
      colors.push([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
    }
  } else {
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
  if (!n) return '#ffffff';
  const toHex = v => Math.round(v).toString(16).padStart(2, '0');
  return `#${toHex(r / n)}${toHex(g / n)}${toHex(b / n)}`;
}

function hexLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function rgbToHex(r, g, b) {
  const h = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Simple k-means over the icon pixels' RGB values, so a logo that is
// itself multi-color (e.g. YouTube's red badge + white triangle) comes
// out as several distinct print colors instead of being flattened into
// one averaged blob. Returns up to K non-empty clusters.
function clusterIconColors(colors, mask, K, N) {
  const idxs = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) idxs.push(i);
  if (!idxs.length) return { clusters: [], assignment: new Uint8Array(mask.length) };

  const k = Math.min(K, idxs.length);
  let centroids = [];
  for (let c = 0; c < k; c++) {
    const pick = idxs[Math.floor((c + 0.5) * idxs.length / k)];
    centroids.push(colors[pick].slice());
  }

  let assignment = new Uint8Array(mask.length);
  for (let iter = 0; iter < 6; iter++) {
    for (const i of idxs) {
      const [r, g, b] = colors[i];
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const [cr, cg, cb] = centroids[c];
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      assignment[i] = best;
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (const i of idxs) {
      const s = sums[assignment[i]];
      s[0] += colors[i][0]; s[1] += colors[i][1]; s[2] += colors[i][2]; s[3]++;
    }
    centroids = sums.map((s, c) => s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centroids[c]);
  }

  // A smooth gradient produces noisy, speckled per-pixel cluster
  // assignment right at the color boundaries — a couple of majority-
  // vote passes cleans that speckling up before any geometry is built.
  for (let pass = 0; pass < 2; pass++) {
    const next = assignment.slice();
    for (const i of idxs) {
      const row = Math.floor(i / N), col = i % N;
      const counts = new Array(k).fill(0);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr, c = col + dc;
          if (r < 0 || r >= N || c < 0 || c >= N) continue;
          const ni = r * N + c;
          if (mask[ni] !== 1) continue;
          counts[assignment[ni]]++;
        }
      }
      let best = assignment[i], bestCount = -1;
      for (let c = 0; c < k; c++) if (counts[c] > bestCount) { bestCount = counts[c]; best = c; }
      next[i] = best;
    }
    assignment = next;
  }

  const clusters = [];
  for (let c = 0; c < k; c++) {
    const count = idxs.reduce((n, i) => n + (assignment[i] === c ? 1 : 0), 0);
    if (!count) continue;
    let hex = rgbToHex(...centroids[c]);
    if (hexLuminance(hex) < 45) hex = '#ffffff'; // stay visible on the black base
    clusters.push({ id: c, hex });
  }
  return { clusters, assignment };
}

// ---------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------
function boxGeom(sx, sy, sz, cx, cy, cz) {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  geo.translate(cx, cy, cz);
  return geo;
}
function boxDesc(sx, sy, sz, cx, cy, cz) {
  return { sx, sy, sz, cx, cy, cz };
}

// Greedy 2D rectangle decomposition: for each still-unclaimed pixel,
// grow a rectangle right as far as it can, then down as far as that
// whole width stays set, then mark it claimed and move on. This turns
// a solid region into a handful of boxes instead of one-per-row, which
// is what keeps the "open edge" count low without the user ever
// needing to hit Repair in Bambu Studio.
function greedyRectangles(flags, N) {
  const claimed = new Uint8Array(N * N);
  const rects = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      if (!flags[idx] || claimed[idx]) continue;
      let colEnd = col;
      while (colEnd + 1 < N && flags[row * N + colEnd + 1] && !claimed[row * N + colEnd + 1]) colEnd++;
      let rowEnd = row;
      outer: while (rowEnd + 1 < N) {
        for (let c = col; c <= colEnd; c++) {
          if (!flags[(rowEnd + 1) * N + c] || claimed[(rowEnd + 1) * N + c]) break outer;
        }
        rowEnd++;
      }
      for (let r = row; r <= rowEnd; r++) for (let c = col; c <= colEnd; c++) claimed[r * N + c] = 1;
      rects.push({ row, col, rowSpan: rowEnd - row + 1, colSpan: colEnd - col + 1 });
    }
  }
  return rects;
}

function rleBoxesFromFlags(flags, N, layerCenterY, layerHeight) {
  const cell = CAP / N;
  const half = CAP / 2;
  return greedyRectangles(flags, N).map(r => {
    const cx = -half + cell * (r.col + r.colSpan / 2);
    const cz = -half + cell * (r.row + r.rowSpan / 2);
    return boxDesc(cell * r.colSpan, layerHeight, cell * r.rowSpan, cx, layerCenterY, cz);
  });
}

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

function crossFrameBoxes(yBottom, yTop) {
  const half = CAP / 2;
  const armHalfLen = CROSS_LEN / 2;
  const armHalfW = CROSS_W / 2;
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

function buildKeycap(job) {
  if (!job.mask) return { groups: [] };

  const N = job.resolution;
  const groups = [];

  const pixelCenterY = TOTAL_H - PIXEL_H / 2;
  const socketTop = TOTAL_H - PIXEL_H - SOCKET_MARGIN;
  const marginCenterY = socketTop + SOCKET_MARGIN / 2;

  const baseFlags = new Uint8Array(job.mask.length);
  for (let i = 0; i < job.mask.length; i++) baseFlags[i] = job.mask[i] === 0 ? 1 : 0;
  const baseBoxes = rleBoxesFromFlags(baseFlags, N, socketTop + (TOTAL_H - socketTop) / 2, TOTAL_H - socketTop);
  baseBoxes.push(...crossFrameBoxes(0, socketTop));
  baseBoxes.push(...rleBoxesFromFlags(job.mask, N, marginCenterY, SOCKET_MARGIN));
  groups.push({ boxes: baseBoxes, hex: BASE_COLOR });

  if (job.mode === 'color' && job._colors) {
    const { clusters, assignment } = clusterIconColors(job._colors, job.mask, 3, N);
    darkIconNote.style.display = clusters.some(c => c.hex === '#ffffff') ? 'block' : 'none';
    clusters.forEach(c => {
      const flags = new Uint8Array(job.mask.length);
      for (let i = 0; i < job.mask.length; i++) {
        flags[i] = (job.mask[i] === 1 && assignment[i] === c.id) ? 1 : 0;
      }
      const boxes = rleBoxesFromFlags(flags, N, pixelCenterY, PIXEL_H);
      if (boxes.length) groups.push({ boxes, hex: c.hex });
    });
  } else {
    darkIconNote.style.display = 'none';
    const boxes = rleBoxesFromFlags(job.mask, N, pixelCenterY, PIXEL_H);
    if (boxes.length) groups.push({ boxes, hex: '#ffffff' });
  }

  return { groups };
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
}

function rebuild() {
  const job = activeJob();
  if (!job) return;

  const { mask, colors } = sampleImageToMask(job.img, job.resolution, job.scalePct);
  job.mask = mask;
  job._colors = colors;

  if (capGroup) { scene.remove(capGroup); }
  const { groups } = buildKeycap(job);
  capGroup = new THREE.Group();
  groups.forEach(g => capGroup.add(instancedPreview(g.boxes, g.hex)));
  scene.add(capGroup);

  job._groups = groups;

  emptyState.style.display = 'none';
  viewerHint.style.display = 'block';
  dl3mfBtn.disabled = false;
}

// ---------------------------------------------------------------
// Multi-color 3MF export — one file per job, base + up to 3 icon
// colors as separate colored objects, read natively by Bambu Studio.
// ---------------------------------------------------------------
function meshGeoFromBoxes(boxes) {
  const geoms = boxes.map(b => boxGeom(b.sx, b.sy, b.sz, b.cx, b.cy, b.cz));
  const merged = mergeGeometries(geoms, false);
  merged.deleteAttribute('normal');
  merged.deleteAttribute('uv');
  const welded = mergeVertices(merged, 1e-5);
  welded.computeVertexNormals();
  return welded;
}

// local (Y-up, icon layer at top y=TOTAL_H) -> print (Z-up, icon flat
// face on the bed at z=0). Rotate -90° about X (x'=x, y'=z, z'=-y),
// then shift up by TOTAL_H so the icon face lands at z=0 and the
// socket opening ends up on top (away from the bed, no supports).
function toPrintSpace(px, py, pz) {
  return [px, pz, TOTAL_H - py];
}

function geometryToXml(geo) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  let vertices = '';
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = toPrintSpace(pos.getX(i), pos.getY(i), pos.getZ(i));
    vertices += `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${z.toFixed(4)}"/>`;
  }
  let triangles = '';
  for (let i = 0; i < idx.count; i += 3) {
    triangles += `<triangle v1="${idx.getX(i)}" v2="${idx.getX(i + 1)}" v3="${idx.getX(i + 2)}"/>`;
  }
  return { vertices, triangles };
}

function build3MFModelXml(groups) {
  let resources = '';
  let build = '';
  groups.forEach((g, i) => {
    const colorId = i * 2 + 1;
    const objectId = i * 2 + 2;
    const xml = geometryToXml(g.geo);
    resources += `<m:colorgroup id="${colorId}"><m:color color="${g.hex}"/></m:colorgroup>`;
    resources += `<object id="${objectId}" type="model" pid="${colorId}" pindex="0"><mesh><vertices>${xml.vertices}</vertices><triangles>${xml.triangles}</triangles></mesh></object>`;
    build += `<item objectid="${objectId}"/>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>${resources}</resources>
  <build>${build}</build>
</model>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// ---- Minimal uncompressed (STORE) ZIP writer ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach(({ name, data }) => {
    const nameBytes = encoder.encode(name);
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const crc = crc32(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, bytes.length, true);
    cd.setUint32(24, bytes.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + bytes.length;
  });

  const centralStart = offset;
  let centralSize = 0;
  central.forEach(c => centralSize += c.length);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/octet-stream' });
}

function safeFilename(name) {
  return name.replace(/\.svg$/i, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'keycap';
}

function build3MFBlob(job) {
  const groupsWithGeo = job._groups.map(g => ({ hex: g.hex, geo: meshGeoFromBoxes(g.boxes) }));
  const modelXml = build3MFModelXml(groupsWithGeo);
  return buildZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES_XML },
    { name: '_rels/.rels', data: RELS_XML },
    { name: '3D/3dmodel.model', data: modelXml },
  ]);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

dl3mfBtn.addEventListener('click', () => {
  const job = activeJob();
  if (!job || !job._groups || !job._groups.length) return;
  downloadBlob(build3MFBlob(job), `${safeFilename(job.name)}.3mf`);
});

dlAllBtn.addEventListener('click', async () => {
  for (const job of jobs) {
    if (!job._groups) {
      const { mask, colors } = sampleImageToMask(job.img, job.resolution, job.scalePct);
      job.mask = mask; job._colors = colors;
      job._groups = buildKeycap(job).groups;
    }
    if (!job._groups.length) continue;
    downloadBlob(build3MFBlob(job), `${safeFilename(job.name)}.3mf`);
    await new Promise(r => setTimeout(r, 300)); // avoid the browser blocking rapid multi-downloads
  }
});
