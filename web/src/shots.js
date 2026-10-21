// Shot list: several cameras over the same blocking (see normalizeShots in presets.js). These keep
// scene.camera pointing at the active shot's camera, so the rest of the editor never sees the list.

import { newId } from './presets.js';
import { rescaleKeys } from './cameraPath.js';

export function selectShot(scene, i) {
  if (i < 0 || i >= scene.shots.length) return scene;
  scene.shot = i;
  scene.camera = scene.shots[i].camera;
  return scene;
}

/** Add a shot after the active one, starting as a copy of its camera, and make it active. */
export function addShot(scene) {
  const n = scene.shots.length + 1;
  const used = new Set(scene.shots.map((s) => s.name));
  let k = n;
  while (used.has(`Shot ${k}`)) k++;
  scene.shots.splice(scene.shot + 1, 0, { id: newId(), name: `Shot ${k}`, camera: structuredClone(scene.camera) });
  return selectShot(scene, scene.shot + 1);
}

/** Remove a shot (never the last one); the one before it becomes active. */
export function removeShot(scene, i = scene.shot) {
  if (scene.shots.length < 2 || i < 0 || i >= scene.shots.length) return scene;
  scene.shots.splice(i, 1);
  return selectShot(scene, Math.max(0, Math.min(scene.shot >= i ? scene.shot - 1 : scene.shot, scene.shots.length - 1)));
}

/** Move a shot one place earlier (-1) or later (+1) in the cut. */
export function moveShot(scene, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= scene.shots.length) return scene;
  [scene.shots[i], scene.shots[j]] = [scene.shots[j], scene.shots[i]];
  return selectShot(scene, scene.shot === i ? j : scene.shot === j ? i : scene.shot);
}

/** All shots share the clip length: stretch every shot's keys when it changes. */
export function rescaleShots(scene, from, to) {
  for (const s of scene.shots) s.camera.keys = rescaleKeys(s.camera.keys, from, to);
  return scene;
}

/** File-safe name for a shot's outputs, e.g. "plaza_dolly_in_02_wide". */
export function shotStem(scene, i) {
  const safe = (t) => t.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe(scene.name || 'shot')}_${String(i + 1).padStart(2, '0')}_${safe(scene.shots[i].name) || 'shot'}`;
}
