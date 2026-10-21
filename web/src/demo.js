// The bundled plaza example, shown in the Render panel when no render server answers (e.g. on the
// static GitHub Pages build). vite.config.js serves/copies these from ../examples to <base>demo/, so
// they aren't duplicated in git. All of them are real A40 outputs of our workflows (examples/).

export const DEMO_FILES = {
  layout: 'layout_plaza_dolly_in.mp4', // playblast (grey layout clip)
  frame0: 'layout_plaza_dolly_in_first.png',
  depth: 'layout_plaza_dolly_in_depth.png',
  look: 'look_gen_plaza_a40.png', // look still generated from the depth (Z-Image-Turbo + depth ControlNet)
  render: 'stage1_genlook_plaza_a40.mp4', // LTX-2.5 + Layout-to-Render, stage 1
};

/** {layout, frame0, depth, look, render} -> URLs under the app's base path ('/' or '/open-cinema-studio/'). */
export function demoUrls(base = '/') {
  const root = base.endsWith('/') ? base : `${base}/`;
  return Object.fromEntries(Object.entries(DEMO_FILES).map(([k, f]) => [k, `${root}demo/${f}`]));
}
