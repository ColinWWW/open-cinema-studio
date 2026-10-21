import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { DEMO_FILES } from './src/demo.js';

const EXPORT_DIR = fileURLToPath(new URL('./exports/', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url));
// The render server (server/app.py). Proxied so the page and the API share an origin.
const RENDER_SERVER = process.env.RENDER_SERVER || 'http://127.0.0.1:8190';

// Dev server only: POST /api/save?name=<file> writes the body to web/exports/, so playblasts land
// on disk next to the repo without a browser download. The real backend (server/) replaces this.
function savePlayblast() {
  return {
    name: 'save-playblast',
    configureServer(server) {
      server.middlewares.use('/api/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        const name = path.basename(new URL(req.url, 'http://localhost').searchParams.get('name') || '');
        if (!/^[\w.-]+\.(mp4|png|json)$/.test(name)) {
          res.statusCode = 400;
          return res.end('bad file name');
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync(EXPORT_DIR, { recursive: true });
          fs.writeFileSync(path.join(EXPORT_DIR, name), Buffer.concat(chunks));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ saved: `web/exports/${name}` }));
        });
      });
    },
  };
}

// The Render panel's demo mode plays the plaza example from examples/. Serve those files at
// <base>demo/ in dev and copy them into the build, so they live in git only once.
function demoFiles() {
  const names = new Set(Object.values(DEMO_FILES));
  return {
    name: 'demo-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = `${server.config.base}demo/`;
        const name = req.url.startsWith(prefix) && decodeURIComponent(req.url.slice(prefix.length).split('?')[0]);
        if (!names.has(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.mp4') ? 'video/mp4' : 'image/png');
        fs.createReadStream(path.join(EXAMPLES_DIR, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of names) {
        this.emitFile({ type: 'asset', fileName: `demo/${name}`, source: fs.readFileSync(path.join(EXAMPLES_DIR, name)) });
      }
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the build under /<repo>/ (pages.yml sets BASE_PATH=/open-cinema-studio/)
  base: process.env.BASE_PATH || '/',
  plugins: [savePlayblast(), demoFiles()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api/render': RENDER_SERVER, '/api/look': RENDER_SERVER, '/api/health': RENDER_SERVER },
  },
});
