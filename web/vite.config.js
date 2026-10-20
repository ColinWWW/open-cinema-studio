import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const EXPORT_DIR = fileURLToPath(new URL('./exports/', import.meta.url));

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

export default defineConfig({
  plugins: [savePlayblast()],
  server: { port: 5173, strictPort: true },
});
