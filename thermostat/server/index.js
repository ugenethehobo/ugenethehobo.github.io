// Run on your own computer: `npm start`. (For Cloudflare, see worker/index.js.)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.js';
import { Auth } from './auth.js';
import { AlexaDriver } from './drivers/alexa.js';
import { MockDriver } from './drivers/mock.js';
import { Engine } from './engine.js';
import { readJson, writeJson } from './files.js';
import { newStore } from './store.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8080;

const driver =
  process.env.DRIVER === 'mock'
    ? new MockDriver()
    : new AlexaDriver({
        saved: readJson('amazon.json', null),
        save: (d) => writeJson('amazon.json', d),
        amazonPage: process.env.AMAZON_PAGE || 'amazon.com',
      });

const saved = readJson('state.json', {});
const store = newStore(saved.store);
let saveTimer = null;
let pending = null;
const engine = new Engine(driver, store, {
  save: (s, live) => {
    pending = { store: s, live };
    saveTimer ||= setTimeout(() => {
      saveTimer = null;
      writeJson('state.json', pending);
    }, 250);
  },
});
engine.restoreLive(saved.live);
const auth = new Auth({
  data: readJson('household.json', {}),
  save: (d) => writeJson('household.json', d),
  passcode: process.env.HOUSEHOLD_PASSCODE,
});
const api = createApi({ engine, auth, driver });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!path.extname(rel)) return serveStatic('/', res); // single-page app
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(file);
    const fresh = ext === '.html' || rel === '/sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': fresh ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    signal: ctrl.signal,
  });
  const response = await api(request, { ip: req.socket.remoteAddress });
  const headers = { ...SECURITY_HEADERS };
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  if (response.body) Readable.fromWeb(response.body).on('error', () => {}).pipe(res);
  else res.end();
});

server.listen(PORT, () => {
  console.log(`Home Climate running on http://localhost:${PORT} (${process.env.DRIVER === 'mock' ? 'demo mode' : 'Alexa'})`);
  if (auth.needsSetup) console.log('Open it and choose a household passcode to finish setup.');
});

engine.start().catch((err) => console.error('Startup failed:', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (pending) writeJson('state.json', pending);
    process.exit(0);
  });
}
