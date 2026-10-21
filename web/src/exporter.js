// Deterministic playblast: step the shot exactly 1/fps per frame, render each frame at the output
// size, and encode to H.264 MP4 in the browser with WebCodecs (no MediaRecorder, no real-time capture).
import * as THREE from 'three';
import { poseAt } from './cameraPath.js';
import { createRenderer } from './clay.js';
import { depthToGray } from './depth.js';
import { checkOutput } from './spec.js';

// View-space depth per pixel, for the look still's depth map (see depth.js).
const DEPTH_MATERIAL = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
    varying float vDepth;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vDepth;
    void main() { gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }`,
});

/** Render the shot camera's current view as a depth PNG (near = white, sky = black). */
async function renderDepth(renderer, world, width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
  const clear = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  world.sky.visible = false;
  world.scene.overrideMaterial = DEPTH_MATERIAL;
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.render(world.scene, world.shotCam);
    const rgba = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, rgba);
    const depth = new Float32Array(width * height);
    for (let i = 0; i < depth.length; i++) depth[i] = rgba[i * 4];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(depthToGray(depth, width, height), width, height), 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, clearAlpha);
    world.scene.overrideMaterial = null;
    world.sky.visible = true;
    target.dispose();
  }
}

export function canExport() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * Render the scene's shot to an MP4 plus PNGs of frame 0 and its depth map.
 * `world` is a ClayWorld already synced to `scene`; editor helpers are hidden while rendering.
 */
export async function exportPlayblast(world, scene, { onProgress } = {}) {
  const { width, height, frames, fps } = scene.output;
  const problems = checkOutput(scene.output);
  if (problems.length) throw new Error(problems.join('; '));
  if (!scene.camera.keys.length) throw new Error('the shot camera has no keyframes');
  if (!canExport()) throw new Error('this browser has no WebCodecs video encoder (use Chrome or Edge)');

  const codec = width * height > 1280 * 720 ? 'avc1.640028' : 'avc1.64001f';
  const config = { codec, width, height, framerate: fps, bitrate: Math.round(width * height * fps * 0.4), latencyMode: 'quality', avc: { format: 'avc' } };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`H.264 ${width}x${height} encoding is not supported in this browser`);

  // Loaded on first export, so the page (and the demo replay that opens first) doesn't wait for it.
  const { ArrayBufferTarget, Muxer } = await import('mp4-muxer');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = createRenderer(canvas, { preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e),
  });
  encoder.configure(config);

  const helpersVisible = world.helpers.visible;
  world.helpers.visible = false;
  let firstFrame = null;
  let depth = null;
  try {
    for (let i = 0; i < frames; i++) {
      world.poseObjects(scene.objects, i); // moving stand-ins
      world.applyShot(scene.camera, poseAt(scene.camera.keys, i, scene.camera.ease), width / height);
      renderer.render(world.scene, world.shotCam);
      if (i === 0) {
        firstFrame = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        depth = await renderDepth(renderer, world, width, height);
        renderer.render(world.scene, world.shotCam); // the canvas again, for the video frame below
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % fps === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
      if (encodeError) throw encodeError;
      onProgress?.(i + 1, frames);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    renderer.dispose();
    world.helpers.visible = helpersVisible;
  }
  return { mp4: new Blob([muxer.target.buffer], { type: 'video/mp4' }), firstFrame, depth };
}
