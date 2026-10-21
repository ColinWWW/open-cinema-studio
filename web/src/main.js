import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MOVES, cameraMove, poseAt, removeKey, setKey, sortKeys } from './cameraPath.js';
import { ClayWorld, ShiftCamera, createRenderer } from './clay.js';
import { canExport, exportPlayblast } from './exporter.js';
import { PRESETS, newId, normalizeScene } from './presets.js';
import { demoUrls } from './demo.js';
import { confirmDialog } from './dialog.js';
import { initRenderPanel, loadServer } from './render.js';
import { initReplay, loadSeen, shouldAutoOpen } from './replay.js';
import { decodeScene, hasSharedScene, shareLink, showToast } from './share.js';
import { addShot, moveShot, removeShot, rescaleShots, selectShot, shotStem } from './shots.js';
import { FRAME_COUNTS, RESOLUTIONS } from './spec.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'ocs.scene.v1';
const FAR_TARGET = 20; // shot-camera targets further than this get pulled in when piloting, so orbiting feels like looking around

// ---------- state ----------
const savedScene = loadSaved();
let scene = savedScene ?? normalizeScene(PRESETS.blocks.make());
let edited = Boolean(savedScene); // the demo replay only swaps in the plaza while this is false
let frame = 0;
let selectedId = null;
let pilot = false;
let playing = false;
let exporting = false;
let renderPanel = null; // {refresh}: set up at the end, once the editor is wired

// ---------- three.js setup ----------
const world = new ClayWorld();
const canvas = $('view');
const renderer = createRenderer(canvas);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;

const workCam = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
workCam.position.set(9, 7, -13);
const orbitWork = new OrbitControls(workCam, canvas);
orbitWork.target.set(0, 1, 2);
orbitWork.update();
const orbitShot = new OrbitControls(world.shotCam, canvas);
orbitShot.enabled = false;
orbitShot.rotateSpeed = 0.3; // framing a shot wants fine control
orbitShot.panSpeed = 0.5;
const activeOrbit = () => (pilot ? orbitShot : orbitWork);

const transform = new TransformControls(workCam, canvas);
transform.addEventListener('dragging-changed', (e) => (activeOrbit().enabled = !e.value));
transform.addEventListener('objectChange', onTransformChange);
world.helpers.add(transform.getHelper());

// Shot-camera glyph and path, shown in the work view only.
const camGlyph = new THREE.Group();
world.helpers.add(camGlyph);
const glyphCam = new ShiftCamera(45, 5 / 3, 0.2, 1.6);
const glyph = new THREE.CameraHelper(glyphCam);
camGlyph.add(glyphCam, glyph);
const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf0b429 }));
camGlyph.add(pathLine);
const keyDots = new THREE.Group();
camGlyph.add(keyDots);
const keyDotGeo = new THREE.OctahedronGeometry(0.12);
const keyDotMat = new THREE.MeshBasicMaterial({ color: 0xf0b429, fog: false });

// ---------- persistence ----------
function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeScene(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
let saveTimer = 0;
function save() {
  edited = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scene));
    } catch {
      /* private mode or full: the scene still works, it just won't survive a reload */
    }
  }, 300);
}

// ---------- scene <-> world ----------
function loadScene(next) {
  scene = normalizeScene(next);
  frame = 0;
  select(null);
  world.syncObjects(scene.objects);
  world.setFog(scene.fog);
  if (pilot) enterPilotPose();
  refreshAll();
  save();
}

const selected = () => scene.objects.find((o) => o.id === selectedId) ?? null;
const lastFrame = () => scene.output.frames - 1;
const outAspect = () => scene.output.width / scene.output.height;

function select(id) {
  selectedId = id;
  const mesh = id ? world.meshes.get(id) : null;
  if (mesh) transform.attach(mesh);
  else transform.detach();
  refreshInspector();
}

function onTransformChange() {
  const obj = selected();
  const mesh = obj && world.meshes.get(obj.id);
  if (!mesh) return;
  if (mesh.position.y < 0) mesh.position.y = 0; // keep things on or above the floor
  obj.position = mesh.position.toArray();
  obj.rotation = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z];
  obj.scale = mesh.scale.toArray().map((v) => Math.max(0.01, v));
  refreshInspector();
  save();
}
transform.addEventListener('mouseUp', () => world.fitShadow());

function floorPointInView() {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), pilot ? world.shotCam : workCam);
  const hit = ray.intersectObject(world.floor)[0];
  const p = hit ? hit.point : orbitWork.target.clone();
  return [round(p.x), 0, round(p.z)];
}
const round = (v) => Math.round(v * 100) / 100;

const DEFAULT_SCALE = { box: [1, 1, 1], person: [1, 1, 1], plane: [4, 3, 1] };
const LABEL = { box: 'box', person: 'person', plane: 'wall' };

function addObject(type) {
  const n = scene.objects.filter((o) => o.type === type).length + 1;
  const obj = { id: newId(), name: `${LABEL[type]} ${n}`, type, position: floorPointInView(), rotation: [0, 0, 0], scale: [...DEFAULT_SCALE[type]], grey: 0.8 };
  scene.objects.push(obj);
  world.syncObjects(scene.objects);
  select(obj.id);
  save();
}

function duplicateSelected() {
  const obj = selected();
  if (!obj) return;
  const copy = structuredClone(obj);
  copy.id = newId();
  copy.name = `${obj.name} copy`;
  copy.position[0] += 1;
  scene.objects.push(copy);
  world.syncObjects(scene.objects);
  select(copy.id);
  save();
}

function deleteSelected() {
  if (!selectedId) return;
  scene.objects = scene.objects.filter((o) => o.id !== selectedId);
  select(null);
  world.syncObjects(scene.objects);
  save();
}

// ---------- shot camera ----------
function currentPose() {
  return poseAt(scene.camera.keys, frame, scene.camera.ease);
}

/** Put the piloted shot camera on the path at the current frame. */
function enterPilotPose() {
  const pose = currentPose();
  if (!pose) return;
  world.applyShot(scene.camera, pose, outAspect());
  const pos = new THREE.Vector3().fromArray(pose.position);
  const tgt = new THREE.Vector3().fromArray(pose.target);
  if (tgt.distanceTo(pos) > FAR_TARGET) tgt.sub(pos).setLength(10).add(pos);
  orbitShot.target.copy(tgt);
  orbitShot.update();
}

function setPilot(on) {
  pilot = on;
  orbitWork.enabled = !on;
  orbitShot.enabled = on;
  transform.camera = on ? world.shotCam : workCam;
  if (on) enterPilotPose();
  $('pilot').classList.toggle('active', on);
  $('pilot').textContent = on ? 'Back to work view' : 'Look through shot camera';
  refreshHud();
}

/** Key the shot camera at the current frame: from the piloted camera, or from the work view. */
function keyCamera() {
  const [cam, target] = pilot ? [world.shotCam, orbitShot.target] : [workCam, orbitWork.target];
  const key = { frame, position: cam.position.toArray().map(round), target: target.toArray().map(round) };
  scene.camera.keys = setKey(scene.camera.keys, key);
  refreshCameraPath();
  refreshTimeline();
  flash(`Keyed shot camera at frame ${frame}${pilot ? '' : ' (from the work view)'}`);
  save();
}

/** Replace the camera keys with a one-click move that starts from the frame-0 framing. */
async function applyMove(move) {
  if (scene.camera.keys.length > 2 && !(await confirmDialog('Replace your camera keys with this move? (It starts from the frame-0 framing.)'))) return;
  const { keys, ease } = cameraMove(move, poseAt(scene.camera.keys, 0, scene.camera.ease), scene.output.frames);
  scene.camera.keys = keys;
  scene.camera.ease = ease;
  setFrame(0);
  refreshCameraFields();
  refreshCameraPath();
  refreshTimeline();
  flash(`${MOVES[move]}: press Space to play it`);
  save();
}

function deleteKey() {
  if (!scene.camera.keys.some((k) => k.frame === frame)) return flash('No camera key on this frame');
  if (scene.camera.keys.length === 1) return flash('The shot needs at least one camera key');
  scene.camera.keys = removeKey(scene.camera.keys, frame);
  refreshCameraPath();
  refreshTimeline();
  save();
}

function jumpKey(dir) {
  const frames = sortKeys(scene.camera.keys).map((k) => k.frame);
  const next = dir > 0 ? frames.find((f) => f > frame) : frames.reverse().find((f) => f < frame);
  if (next !== undefined) setFrame(next);
}

function setFrame(f) {
  frame = Math.max(0, Math.min(lastFrame(), Math.round(f)));
  if (pilot) enterPilotPose();
  refreshTimeline();
  refreshHud();
}

function refreshCameraPath() {
  const n = scene.output.frames;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3().fromArray(poseAt(scene.camera.keys, i, scene.camera.ease).position));
  pathLine.geometry.dispose();
  pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  keyDots.clear();
  for (const k of scene.camera.keys) {
    const dot = new THREE.Mesh(keyDotGeo, keyDotMat);
    dot.position.fromArray(k.position);
    keyDots.add(dot);
  }
}

// ---------- UI refresh ----------
function refreshAll() {
  refreshHeader();
  refreshShots();
  refreshInspector();
  refreshCameraFields();
  refreshCameraPath();
  refreshTimeline();
  refreshHud();
  renderPanel?.refresh(); // e.g. "Render all N shots" when shots change while the panel is open
}

function refreshHeader() {
  $('resolution').value = `${scene.output.width}x${scene.output.height}`;
  $('frames').value = String(scene.output.frames);
}

function refreshInspector() {
  const obj = selected();
  $('inspector').hidden = !obj;
  $('sel-label').textContent = obj ? obj.name : 'nothing selected';
  if (!obj) return;
  $('obj-name').value = obj.name;
  for (const input of document.querySelectorAll('#inspector [data-field]')) {
    if (document.activeElement !== input) input.value = round(obj[input.dataset.field][+input.dataset.i]);
  }
  if (document.activeElement !== $('obj-roty')) $('obj-roty').value = Math.round(THREE.MathUtils.radToDeg(obj.rotation[1]));
  $('obj-grey').value = obj.grey;
}

function refreshShots() {
  const sel = $('shot');
  sel.innerHTML = '';
  scene.shots.forEach((s, i) => sel.add(new Option(`${i + 1}. ${s.name}`, String(i))));
  sel.value = String(scene.shot);
  if (document.activeElement !== $('shot-name')) $('shot-name').value = scene.shots[scene.shot].name;
  $('shot-del').disabled = scene.shots.length < 2;
  $('shot-up').disabled = scene.shot === 0;
  $('shot-down').disabled = scene.shot === scene.shots.length - 1;
}

/** Edit the shot list (fn changes scene.shots / scene.shot), then show the active shot from frame 0. */
function changeShots(fn) {
  fn(scene);
  frame = 0;
  if (pilot) enterPilotPose();
  refreshAll();
  save();
}

/** For the render panel: make shot i active and return its file stem. */
function showShot(i) {
  if (i !== scene.shot) changeShots((s) => selectShot(s, i));
  return shotStem(scene, i);
}

function refreshCameraFields() {
  $('cam-fov').value = scene.camera.fov;
  $('cam-shift').value = scene.camera.lensShift;
  $('cam-ease').value = scene.camera.ease;
}

function refreshTimeline() {
  const last = lastFrame();
  const slider = $('frame');
  slider.max = String(last);
  slider.value = String(frame);
  $('frame-label').textContent = `${frame} / ${last}`;
  $('key-marks').innerHTML = scene.camera.keys
    .map((k) => `<span style="left:${(100 * k.frame) / Math.max(1, last)}%" title="key @ ${k.frame}"></span>`)
    .join('');
}

let flashMsg = '';
let flashTimer = 0;
function flash(msg) {
  flashMsg = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashMsg = '';
    refreshHud();
  }, 2000);
  refreshHud();
}

function refreshHud() {
  const base = pilot ? `SHOT CAMERA · frame ${frame} · K to key` : `Work view · inset = shot camera at frame ${frame}`;
  $('hud').textContent = flashMsg ? `${base} — ${flashMsg}` : base;
}

// ---------- render loop ----------
function fitRect(W, H, aspect) {
  let w = W;
  let h = W / aspect;
  if (h > H) {
    h = H;
    w = H * aspect;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

let lastTime = performance.now();
let playhead = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (exporting) return; // the exporter owns the shot camera and helper visibility until it finishes
  if (playing) {
    playhead = (playhead + dt * scene.output.fps) % scene.output.frames;
    if (Math.floor(playhead) !== frame) setFrame(Math.floor(playhead));
  }

  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (canvas.width !== Math.floor(W * renderer.getPixelRatio()) || canvas.height !== Math.floor(H * renderer.getPixelRatio())) {
    renderer.setSize(W, H, false);
  }
  const aspect = outAspect();
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.setClearColor(0x15171a);
  renderer.clear();

  if (pilot) {
    // letterboxed view through the shot camera (posed by orbitShot)
    world.shotCam.fov = scene.camera.fov;
    world.shotCam.lensShift = scene.camera.lensShift;
    world.shotCam.aspect = aspect;
    world.shotCam.updateProjectionMatrix();
    const r = fitRect(W, H, aspect);
    camGlyph.visible = false;
    renderer.setViewport(r.x, r.y, r.w, r.h);
    renderer.setScissor(r.x, r.y, r.w, r.h);
    renderer.setScissorTest(true);
    renderer.render(world.scene, world.shotCam);
    return;
  }

  // work view
  const pose = currentPose();
  world.applyShot(scene.camera, pose, aspect);
  glyphCam.fov = scene.camera.fov;
  glyphCam.lensShift = scene.camera.lensShift;
  glyphCam.aspect = aspect;
  glyphCam.position.copy(world.shotCam.position);
  glyphCam.quaternion.copy(world.shotCam.quaternion);
  glyphCam.updateProjectionMatrix();
  glyphCam.updateMatrixWorld();
  glyph.update();
  camGlyph.visible = true;
  world.helpers.visible = true;
  workCam.aspect = W / H;
  workCam.updateProjectionMatrix();
  renderer.render(world.scene, workCam);

  // inset: what the shot camera sees at this frame
  const pw = Math.round(Math.min(W * 0.34, 440));
  const ph = Math.round(pw / aspect);
  const x = W - pw - 12;
  const y = 12;
  world.helpers.visible = false;
  renderer.setViewport(x - 2, y - 2, pw + 4, ph + 4);
  renderer.setScissor(x - 2, y - 2, pw + 4, ph + 4);
  renderer.setScissorTest(true);
  renderer.setClearColor(0xf0b429);
  renderer.clear();
  renderer.setViewport(x, y, pw, ph);
  renderer.setScissor(x, y, pw, ph);
  renderer.render(world.scene, world.shotCam);
  world.helpers.visible = true;
}

// ---------- picking ----------
let downAt = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || e.button !== 0 || transform.dragging) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4 || transform.axis) return;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  let ndc;
  if (pilot) {
    const r = fitRect(W, H, outAspect());
    ndc = new THREE.Vector2(((e.clientX - rect.left - r.x) / r.w) * 2 - 1, -((e.clientY - rect.top - r.y) / r.h) * 2 + 1);
  } else {
    ndc = new THREE.Vector2(((e.clientX - rect.left) / W) * 2 - 1, -((e.clientY - rect.top) / H) * 2 + 1);
  }
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, pilot ? world.shotCam : workCam);
  const hit = ray.intersectObjects(world.objects.children, false)[0];
  select(hit ? hit.object.userData.id : null);
});

// ---------- controls wiring ----------
$('preset').add(new Option('Load preset…', ''));
for (const [key, preset] of Object.entries(PRESETS)) $('preset').add(new Option(preset.label, key));
$('preset').value = '';
$('preset').addEventListener('change', async (e) => {
  const key = e.target.value;
  if (!key) return;
  if (scene.objects.length && !(await confirmDialog(`Replace the current scene with "${PRESETS[key].label}"?`))) {
    e.target.value = '';
    return;
  }
  loadScene(PRESETS[key].make());
  e.target.value = '';
});

for (const [w, h] of RESOLUTIONS) $('resolution').add(new Option(`${w}×${h}`, `${w}x${h}`));
$('resolution').addEventListener('change', (e) => {
  const [w, h] = e.target.value.split('x').map(Number);
  scene.output.width = w;
  scene.output.height = h;
  if (pilot) enterPilotPose();
  renderPanel?.refresh(); // the look still's aspect warning depends on the size
  save();
});
for (const n of FRAME_COUNTS) $('frames').add(new Option(`${n} (${(n / 24).toFixed(1)} s)`, String(n)));
$('frames').addEventListener('change', (e) => {
  const n = Number(e.target.value);
  rescaleShots(scene, scene.output.frames, n);
  scene.output.frames = n;
  setFrame(Math.min(frame, n - 1));
  refreshCameraPath();
  refreshTimeline();
  save();
});

$('save-json').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' }));
  a.download = `${scene.name || 'shot'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('load-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    loadScene(JSON.parse(await file.text()));
    flash(`Loaded ${file.name}`);
  } catch (err) {
    flash(`Could not load ${file.name}: ${err.message}`);
  }
});

// ---------- share as a link ----------
$('share-link').addEventListener('click', async () => {
  const link = await shareLink(scene, location.href);
  if (!link.ok) return showToast(link.message);
  try {
    await navigator.clipboard.writeText(link.url);
    showToast('Link copied. Anyone who opens it gets this scene.');
  } catch {
    // No clipboard (plain http, or permission refused): leave the link in the address bar to copy by hand.
    history.replaceState(null, '', link.url);
    showToast('Could not reach the clipboard, so the link is in the address bar. Copy it from there.');
  }
});

// Opens a #scene=… link. The hash is cleared afterwards so a reload doesn't ask again; a damaged one is ignored.
async function openSharedScene() {
  if (!hasSharedScene(location.hash)) return;
  const shared = await decodeScene(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!shared) return showToast('That share link is damaged or cut short, so it was ignored.');
  if (edited && scene.objects.length && !(await confirmDialog(`Replace your current scene with the shared "${shared.name}"?`, { ok: 'Open shared scene' }))) return;
  loadScene(shared);
  showToast(`Opened the shared scene "${shared.name}".`);
}
const openedShared = hasSharedScene(location.hash);
window.addEventListener('hashchange', () => openSharedScene().catch(() => {}));

for (const btn of document.querySelectorAll('[data-add]')) btn.addEventListener('click', () => addObject(btn.dataset.add));
function setMode(mode) {
  transform.setMode(mode);
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
}
for (const btn of document.querySelectorAll('[data-mode]')) btn.addEventListener('click', () => setMode(btn.dataset.mode));
$('duplicate').addEventListener('click', duplicateSelected);
$('delete').addEventListener('click', deleteSelected);

$('obj-name').addEventListener('input', (e) => {
  const obj = selected();
  if (!obj) return;
  obj.name = e.target.value;
  $('sel-label').textContent = obj.name;
  save();
});
for (const input of document.querySelectorAll('#inspector [data-field]')) {
  input.addEventListener('input', () => {
    const obj = selected();
    const v = parseFloat(input.value);
    if (!obj || !Number.isFinite(v)) return;
    obj[input.dataset.field][+input.dataset.i] = input.dataset.field === 'scale' ? Math.max(0.01, v) : v;
    world.applyObject(world.meshes.get(obj.id), obj);
    world.fitShadow();
    save();
  });
}
$('obj-roty').addEventListener('input', (e) => {
  const obj = selected();
  const v = parseFloat(e.target.value);
  if (!obj || !Number.isFinite(v)) return;
  obj.rotation[1] = THREE.MathUtils.degToRad(v);
  world.applyObject(world.meshes.get(obj.id), obj);
  save();
});
$('obj-grey').addEventListener('input', (e) => {
  const obj = selected();
  if (!obj) return;
  obj.grey = parseFloat(e.target.value);
  world.applyObject(world.meshes.get(obj.id), obj);
  save();
});

$('pilot').addEventListener('click', () => setPilot(!pilot));
$('shot').addEventListener('change', (e) => changeShots((s) => selectShot(s, Number(e.target.value))));
$('shot-add').addEventListener('click', () => {
  changeShots(addShot);
  flash(`${scene.shots[scene.shot].name}: a copy of the shot before it. Reframe it, or apply a move`);
});
$('shot-del').addEventListener('click', async () => {
  if (await confirmDialog(`Delete "${scene.shots[scene.shot].name}"?`, { ok: 'Delete' })) changeShots(removeShot);
});
$('shot-up').addEventListener('click', () => changeShots((s) => moveShot(s, s.shot, -1)));
$('shot-down').addEventListener('click', () => changeShots((s) => moveShot(s, s.shot, 1)));
$('shot-name').addEventListener('input', (e) => {
  scene.shots[scene.shot].name = e.target.value.trim() || `Shot ${scene.shot + 1}`;
  refreshShots();
  save();
});
for (const [key, label] of Object.entries(MOVES)) $('cam-move').add(new Option(label, key));
$('cam-move-apply').addEventListener('click', () => applyMove($('cam-move').value));
$('cam-fov').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v) && v >= 10 && v <= 120) scene.camera.fov = v;
  save();
});
$('cam-shift').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v) && Math.abs(v) <= 1) scene.camera.lensShift = v;
  save();
});
$('cam-ease').addEventListener('change', (e) => {
  scene.camera.ease = e.target.value;
  refreshCameraPath();
  save();
});

function togglePlay() {
  playing = !playing;
  playhead = frame;
  $('play').textContent = playing ? '⏸' : '▶';
}
$('play').addEventListener('click', togglePlay);
$('frame').addEventListener('input', (e) => setFrame(Number(e.target.value)));
$('set-key').addEventListener('click', keyCamera);
$('del-key').addEventListener('click', deleteKey);
$('prev-key').addEventListener('click', () => jumpKey(-1));
$('next-key').addEventListener('click', () => jumpKey(1));

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || exporting) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'd') {
    e.preventDefault();
    duplicateSelected();
  } else if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  } else if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'r') setMode('scale');
  else if (k === 'delete' || k === 'backspace') deleteSelected();
  else if (k === 'escape') select(null);
  else if (k === 'c') setPilot(!pilot);
  else if (k === 'k') keyCamera();
  else if (k === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (k === ',') setFrame(frame - 1);
  else if (k === '.') setFrame(frame + 1);
});

// ---------- export ----------
const fileStem = () => {
  const name = scene.shots.length > 1 ? shotStem(scene, scene.shot) : (scene.name || 'shot').replace(/[^\w.-]+/g, '_');
  return `${name}_${scene.output.width}x${scene.output.height}_${scene.output.frames}f`;
};

async function saveToDevServer(name, blob) {
  if (!import.meta.env.DEV) return null; // only `npm run dev` has /api/save
  try {
    const res = await fetch(`/api/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return res.ok ? (await res.json()).saved : null;
  } catch {
    return null;
  }
}

/** Export the playblast. Returns {mp4, firstFrame, depth, saved} (blobs, and dev-server paths when available). */
async function runExport() {
  if (exporting) return null;
  exporting = true;
  playing = false;
  $('play').textContent = '▶';
  const panel = $('export-panel');
  panel.hidden = false;
  $('export-links').innerHTML = '';
  $('export-status').textContent = 'Rendering…';
  $('export-progress').value = 0;
  $('export').disabled = true;
  try {
    const result = await exportPlayblast(world, scene, {
      onProgress: (i, n) => {
        $('export-progress').value = i / n;
        $('export-status').textContent = `Rendering frame ${i} / ${n}`;
      },
    });
    const stem = fileStem();
    const saved = [
      await saveToDevServer(`${stem}.mp4`, result.mp4),
      await saveToDevServer(`${stem}_first.png`, result.firstFrame),
      await saveToDevServer(`${stem}_depth.png`, result.depth),
      await saveToDevServer(`${stem}.json`, new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })),
    ].filter(Boolean);
    const links = [
      [result.mp4, `${stem}.mp4`, 'Download MP4'],
      [result.firstFrame, `${stem}_first.png`, 'Download frame 0'],
      [result.depth, `${stem}_depth.png`, 'Download depth'],
    ];
    $('export-links').innerHTML = '';
    for (const [blob, name, label] of links) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.textContent = label;
      $('export-links').append(a);
    }
    $('export-status').textContent = saved.length
      ? `Done: ${scene.output.frames} frames. Saved ${saved.join(', ')}`
      : `Done: ${scene.output.frames} frames at ${scene.output.width}×${scene.output.height}, 24 fps.`;
    return { ...result, saved };
  } catch (err) {
    $('export-status').textContent = `Export failed: ${err.message}`;
    throw err;
  } finally {
    exporting = false;
    $('export').disabled = false;
  }
}
$('export').addEventListener('click', () => runExport().catch(() => {}));
$('export-close').addEventListener('click', () => ($('export-panel').hidden = true));
if (!canExport()) {
  $('export').disabled = true;
  $('export').title = 'Needs a browser with WebCodecs (Chrome or Edge)';
}

const demo = demoUrls(import.meta.env.BASE_URL);
renderPanel = initRenderPanel({
  getScene: () => scene,
  showShot,
  exportPlayblast: runExport,
  demo,
  proxied: import.meta.env.DEV, // the dev server forwards /api to the render server
});

// The demo replay loads the plaza behind itself, but never over a scene the user has worked on.
initReplay({
  demo,
  onStart: () => {
    if (!edited) loadScene(PRESETS.plaza.make());
  },
  onRender: () => $('render-open').click(),
  autoOpen: !openedShared && shouldAutoOpen({ dev: import.meta.env.DEV, server: loadServer(), seen: loadSeen() }),
});

// Hook for scripted checks.
window.ocs = {
  get scene() {
    return scene;
  },
  world,
  loadScene,
  loadPreset: (key) => loadScene(PRESETS[key].make()),
  setFrame,
  exportPlayblast: runExport,
};

// ---------- go ----------
world.syncObjects(scene.objects);
world.setFog(scene.fog);
refreshAll();
requestAnimationFrame(tick);
openSharedScene().catch(() => {});
