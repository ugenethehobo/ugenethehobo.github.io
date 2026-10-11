import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';
import { Engine } from './engine.js';
import { loadStore, saveStore } from './store.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8080;

const driverName = process.env.DRIVER || 'alexa';
const { AlexaDriver } = driverName === 'alexa' ? await import('./drivers/alexa.js') : {};
const { MockDriver } = driverName === 'mock' ? await import('./drivers/mock.js') : {};
const driver = driverName === 'mock' ? new MockDriver() : new AlexaDriver();

const store = loadStore();
const engine = new Engine(driver, store);
const auth = new Auth();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }));
      }
    });
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // Single-page app: unknown paths get the app shell.
      if (!path.extname(rel)) return serveStatic({ url: '/' }, res);
      return send(res, 404, 'Not found');
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

// Live updates over Server-Sent Events, so every phone in the house sees a
// change the moment anyone makes it.
const clients = new Set();
let pushTimer = null;
engine.on('update', () => {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const data = `event: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`;
    for (const c of clients) c.write(data);
  }, 50);
});
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 25000).unref();

async function api(req, res, url) {
  const ip = req.socket.remoteAddress;
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const { cookie, name } = auth.login(body.passcode, body.name, ip);
    return send(res, 200, { ok: true, name }, { 'Set-Cookie': cookie });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
  }
  const user = auth.user(req);
  if (!user) return send(res, 401, { error: 'Sign in first' });
  const by = user.name;

  const reply = async (resultsPromise) => {
    const results = await resultsPromise;
    send(res, 200, { results, state: engine.snapshot() });
  };

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/state':
      return send(res, 200, { me: by, state: engine.snapshot() });
    case 'GET /api/events': {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    case 'POST /api/control':
      return reply(engine.control(await readBody(req), by));
    case 'POST /api/resume':
      return reply(engine.resume(by));
    case 'PUT /api/schedule':
      return reply(engine.setSchedule(await readBody(req), by));
    case 'PUT /api/settings':
      return reply(engine.setSettings(await readBody(req), by));
    case 'POST /api/refresh':
      await engine.refresh();
      return send(res, 200, { state: engine.snapshot() });
    case 'POST /api/rediscover':
      await engine.discover();
      await engine.refresh();
      return send(res, 200, { state: engine.snapshot() });
    case 'POST /api/signout-everyone':
      auth.rotate();
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
    case 'GET /api/debug/devices':
      return send(res, 200, await driver.raw());
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  try {
    await api(req, res, url);
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 400, { error: err.message || String(err), state: engine.snapshot() });
  }
});

server.listen(PORT, () => {
  console.log(`Home Climate running on http://localhost:${PORT} (driver: ${driverName})`);
  if (!process.env.HOUSEHOLD_PASSCODE) console.log(`Household passcode: ${auth.passcode}  (set HOUSEHOLD_PASSCODE to choose your own)`);
});

engine.start().catch((err) => console.error('Startup failed:', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveStore(store, { now: true });
    process.exit(0);
  });
}
