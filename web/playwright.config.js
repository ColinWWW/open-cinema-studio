// Smoke test of the production build as GitHub Pages serves it (under /open-cinema-studio/), with no
// render server: the page loads, the demo replay opens by itself and plays real files, the editor works.
import { defineConfig } from '@playwright/test';

const BASE = '/open-cinema-studio/';
const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE}`,
    browserName: 'chromium',
    channel: process.env.PW_CHANNEL || undefined, // 'chrome' in CI: real Chrome plays the H.264 demo clips
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { BASE_PATH: BASE },
    url: `http://127.0.0.1:${PORT}${BASE}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
