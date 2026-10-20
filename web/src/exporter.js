// Deterministic playblast: step the shot exactly 1/fps per frame, render each frame at the output
// size, and encode to H.264 MP4 in the browser with WebCodecs (no MediaRecorder, no real-time capture).
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { poseAt } from './cameraPath.js';
import { createRenderer } from './clay.js';
import { checkOutput } from './spec.js';

export function canExport() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * Render the scene's shot to an MP4 plus a PNG of frame 0.
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
  try {
    for (let i = 0; i < frames; i++) {
      world.applyShot(scene.camera, poseAt(scene.camera.keys, i, scene.camera.ease), width / height);
      renderer.render(world.scene, world.shotCam);
      if (i === 0) firstFrame = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
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
  return { mp4: new Blob([muxer.target.buffer], { type: 'video/mp4' }), firstFrame };
}
