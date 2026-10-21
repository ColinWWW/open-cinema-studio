// The Render panel end to end, with no GPU: the Vite dev server (which proxies /api) in front of the render
// server (server/app.py), comfy-api-proxy and the mock ComfyUI (server/mock_comfyui.py), the same chain as
// server/tests/test_e2e.py. Run from web/: npx playwright test -c playwright.render.config.js
import { defineConfig } from '@playwright/test';

const PYTHON = process.env.PYTHON || 'python';
// Not the defaults (8188/8189/8190/5173), so a real ComfyUI or dev server on this machine is left alone.
const PORTS = { comfy: 8288, proxy: 8289, server: 8290, web: 5273 };
// Seconds a mock job takes: enough that Cancel lands while one is running (the panel polls every second).
const MOCK_DELAY = process.env.MOCK_DELAY || '4';

const python = (args, url) => ({
  command: `${PYTHON} ${args}`,
  cwd: '..',
  url,
  reuseExistingServer: false,
  timeout: 60_000,
  stdout: 'pipe',
});

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'render_flow.spec.js',
  timeout: 240_000,
  retries: 0, // the flow is one serial story; a retry would hide a flaky step
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORTS.web}/`,
    browserName: 'chromium',
    channel: process.env.PW_CHANNEL || undefined, // 'chrome' in CI: WebCodecs H.264 for the playblast, and playback
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
  },
  webServer: [
    python(`-m server.mock_comfyui --port ${PORTS.comfy} --delay ${MOCK_DELAY}`, `http://127.0.0.1:${PORTS.comfy}/queue`),
    python(`-c "from comfy_api_proxy.cli import main; main()" --comfyui http://127.0.0.1:${PORTS.comfy} --port ${PORTS.proxy}`,
      `http://127.0.0.1:${PORTS.proxy}/api/v2/health`),
    python(`-m server.app --port ${PORTS.server} --comfy-url http://127.0.0.1:${PORTS.proxy}`,
      `http://127.0.0.1:${PORTS.server}/api/health`),
    {
      command: `npx vite --host 127.0.0.1 --port ${PORTS.web} --strictPort`,
      env: { RENDER_SERVER: `http://127.0.0.1:${PORTS.server}` },
      url: `http://127.0.0.1:${PORTS.web}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
