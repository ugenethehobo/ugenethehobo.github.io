// Cloudflare Workers entry. Static files in public/ are served by Workers
// Static Assets; /api/* goes to a single Durable Object ("the home") that
// keeps all state. Hubs hold a WebSocket to it using the Hibernation API, so
// an idle connection costs nothing; the object wakes for a message, a phone
// request or its alarm (schedules and game-day polling), then sleeps again.
import { DurableObject } from 'cloudflare:workers';
import { createApi } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { Home as HomeLogic } from '../server/home.js';

const HUB_ID = /^[a-z0-9-]{4,40}$/;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'home-lights/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class Home extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Hubs may also send a text "ping"; answer it without waking up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.ready = ctx.blockConcurrencyWhile(() => this.#boot());
  }

  async #boot() {
    const kv = this.ctx.storage;
    const [config, game, scan, household] = await Promise.all(['config', 'game', 'scan', 'household'].map((k) => kv.get(k)));
    this.home = new HomeLogic({
      saved: config,
      game,
      scan,
      persist: (k, v) => kv.put(k, v),
      fetchJson,
      hubs: {
        send: (id, msg) => this.#send(id, msg),
        online: () => this.#online(),
        close: (id, code, reason) => {
          for (const ws of this.ctx.getWebSockets(`hub:${id}`)) {
            try {
              ws.close(code, reason);
            } catch {}
          }
        },
      },
    });
    this.auth = new Auth({
      data: household || {},
      save: (d) => kv.put('household', d),
      passcode: this.env.HOUSEHOLD_PASSCODE || null,
      secure: true,
    });
    this.api = createApi({ home: this.home, auth: this.auth });
  }

  #send(id, msg) {
    let sent = false;
    for (const ws of this.ctx.getWebSockets(`hub:${id}`)) {
      try {
        ws.send(JSON.stringify(msg));
        sent = true;
      } catch {}
    }
    return sent;
  }

  #online() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.id) ids.add(a.id);
    }
    return [...ids];
  }

  // Keep exactly one alarm, at the next time the house needs to wake.
  async #arm(force = false) {
    const at = this.home.nextWake();
    const current = force ? null : await this.ctx.storage.getAlarm();
    if (at == null) {
      if (current != null) await this.ctx.storage.deleteAlarm();
    } else if (current == null || Math.abs(current - at) > 1000) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  async alarm() {
    await this.ready;
    try {
      await this.home.tick();
    } finally {
      await this.#arm(true);
    }
  }

  #hubUpgrade(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') || '').toLowerCase();
    if (!HUB_ID.test(id)) return new Response('Bad hub id', { status: 400 });
    const status = this.home.hubConnect(id, url.searchParams.get('token') || '', (url.searchParams.get('fw') || '').slice(0, 20));
    // One connection per hub: drop an older one (e.g. after a Wi-Fi blip).
    for (const old of this.ctx.getWebSockets(`hub:${id}`)) {
      try {
        old.close(4000, 'replaced');
      } catch {}
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`hub:${id}`]);
    server.serializeAttachment({ id: status === 'ok' ? id : null, pending: id });
    server.send(JSON.stringify({ t: status === 'ok' ? 'ready' : 'pending' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    await this.ready;
    const a = ws.deserializeAttachment();
    if (!a?.id || typeof data !== 'string' || data.length > 20000) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    this.home.onHubMessage(a.id, msg);
    await this.#arm();
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {}
  }

  async webSocketError() {}

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/api/hub') return this.#hubUpgrade(request);
    const res = await this.api(request, { ip: request.headers.get('CF-Connecting-IP') || 'unknown' });
    await this.#arm();
    return res;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const home = env.HOME.get(env.HOME.idFromName('home'));
      return home.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
