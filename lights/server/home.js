// The house: lights, hubs, rooms, schedules and Chiefs mode. All decisions
// live here; the Cloudflare Durable Object (worker/index.js) only stores what
// this hands it, carries messages to and from the hubs, and wakes it up.
//
// Hubs are small ESP32 boards at home that talk Bluetooth to the lights.
// They stay connected over a WebSocket and run light shows on their own, so
// the server only says "do this" and goes back to sleep.

import { ctToHex, hexToXy, xyToHex } from './color.js';
import { buildEffect, DEFAULT_EVENTS, effectLength, EVENTS } from './effects.js';
import { classifyPlay, describe, ESPN, findGame, parseSummary, pickEvent } from './game.js';
import { cleanEntry, nextRun, runsBetween, sunToday } from './schedule.js';
import { isValidTimeZone } from './time.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DEFAULT_TZ = 'America/Chicago';
const KC = { primary: '#e31837', secondary: '#ffb612' };

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const text = (s, n = 40) => String(s ?? '').trim().slice(0, n);
const randomId = (bytes = 8) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const DEFAULT_CHIEFS = {
  enabled: true,
  teamId: '12', // Kansas City on ESPN
  lights: [], // empty = every light
  bri: 200,
  pregameMin: 30,
  afterGame: 'restore', // or 'stay'
  postgameMin: 20,
  delaySec: 0, // how far your TV runs behind the live game
  pollSec: 8,
  events: { ...DEFAULT_EVENTS },
};

function newConfig(saved = {}) {
  const c = {
    lights: {},
    rooms: [],
    hubs: {},
    pendingHubs: {},
    schedules: [],
    schedCheckedAt: 0,
    settings: { tz: null, lat: null, lon: null, place: '' },
    log: [],
    ...saved,
  };
  c.settings = { tz: null, lat: null, lon: null, place: '', ...(saved.settings || {}) };
  c.chiefs = { ...DEFAULT_CHIEFS, ...(saved.chiefs || {}) };
  c.chiefs.events = { ...DEFAULT_EVENTS, ...(saved.chiefs?.events || {}) };
  return c;
}

function newGame(saved) {
  return {
    phase: 'idle', // idle | scheduled | pregame | live | final
    event: null,
    doneId: null,
    nextCheck: 0,
    nextPoll: 0,
    seq: null,
    prev: { home: 0, away: 0 },
    score: null,
    detail: '',
    lastPlay: null,
    recent: [],
    queue: [],
    busyUntil: 0,
    active: false,
    manual: false,
    saved: null,
    restoreAt: null,
    error: null,
    ...(saved || {}),
  };
}

// The part of a light's state the hub and the app care about.
const lightState = (l) => ({ on: l.on, bri: l.bri, ...(l.mode === 'ct' && l.ct ? { ct: l.ct } : l.xy ? { xy: l.xy } : {}) });

export class Home {
  // persist(key, value) stores data. hubs: { send(id, msg) -> bool,
  // online() -> [ids], close(id, code, reason) }. fetchJson(url) -> object.
  constructor({ saved, game, scan, persist = () => {}, hubs, fetchJson, now = () => Date.now() } = {}) {
    this.config = newConfig(saved);
    this.game = newGame(game);
    this.scanState = scan || { until: 0, found: [] };
    this.persist = persist;
    this.hubs = hubs;
    this.fetchJson = fetchJson;
    this.now = now;
    this.schedFrom = this.config.schedCheckedAt || 0;
  }

  // ---------- saving ----------

  save() {
    this.persist('config', this.config);
  }
  saveGame() {
    this.persist('game', this.game);
  }
  saveScan() {
    this.persist('scan', this.scanState);
  }

  log(by, what) {
    this.config.log.unshift({ at: this.now(), by: by || null, text: what });
    this.config.log.length = Math.min(this.config.log.length, 40);
  }

  get tz() {
    const tz = this.config.settings.tz;
    return tz && isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  }

  get loc() {
    const { lat, lon } = this.config.settings;
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }

  // The first phone to show up tells us the household's time zone.
  noteTimeZone(tz) {
    if (!this.config.settings.tz && tz && isValidTimeZone(tz)) {
      this.config.settings.tz = tz;
      this.save();
    }
  }

  // ---------- what the app sees ----------

  snapshot() {
    const now = this.now();
    const online = new Set(this.hubs.online());
    const c = this.config;
    const gameIds = new Set(this.gameLightIds());
    const lights = Object.values(c.lights)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({
        ...l,
        hubOnline: !!l.hub && online.has(l.hub),
        reachable: !!l.hub && online.has(l.hub) && (l.connected || l.standby) && !l.unpaired,
        hex: l.mode === 'ct' && l.ct ? ctToHex(l.ct) : l.xy ? xyToHex(l.xy) : ctToHex(366),
        inGame: this.game.active && gameIds.has(l.id),
      }));
    const rooms = [...c.rooms];
    for (const l of lights) if (l.room && !rooms.includes(l.room)) rooms.push(l.room);
    const next = nextRun(c.schedules, now, this.tz, this.loc);
    const sun = sunToday(now, this.tz, this.loc);
    return {
      now,
      tz: this.tz,
      settings: c.settings,
      sun,
      lights,
      rooms,
      hubs: [
        ...Object.entries(c.hubs).map(([id, h]) => ({ id, name: h.name, fw: h.fw || null, online: online.has(id), pending: false, lights: lights.filter((l) => l.hub === id).length })),
        ...Object.entries(c.pendingHubs).map(([id, h]) => ({ id, name: `New hub ${id.slice(-5)}`, fw: h.fw || null, online: online.has(id), pending: true, lights: 0, since: h.since })),
      ],
      scan: {
        running: now < this.scanState.until,
        until: this.scanState.until,
        found: this.scanState.found.map((f) => ({ ...f, hue: f.hue !== false, known: !!c.lights[f.id] && !c.lights[f.id].unpaired })),
      },
      schedules: c.schedules,
      nextSchedule: next ? { id: next.entry.id, name: next.entry.name, at: next.at } : null,
      chiefs: this.chiefsView(now),
      log: c.log.slice(0, 25),
      hubLog: (this.scanState.log || []).slice(0, 20),
    };
  }

  chiefsView(now) {
    const g = this.game;
    const ev = g.event;
    return {
      settings: this.config.chiefs,
      events: Object.entries(EVENTS).map(([id, e]) => ({ id, ...e })),
      phase: g.phase,
      active: g.active,
      manual: g.manual,
      game: ev
        ? {
            id: ev.id,
            name: ev.name,
            start: ev.start,
            home: ev.home,
            us: ev.us,
            opp: ev.opp,
            detail: g.detail || ev.detail,
            score: g.score,
            pregameAt: ev.start - this.config.chiefs.pregameMin * MIN,
          }
        : null,
      lastPlay: g.lastPlay,
      recent: g.recent,
      espnLagSec: g.lastPlay?.wall ? Math.round((g.lastPlay.seenAt - g.lastPlay.wall) / 1000) : null,
      restoreAt: g.restoreAt,
      nextCheck: g.nextCheck,
      error: g.error,
      polling: g.phase === 'live' || g.phase === 'pregame',
      now,
    };
  }

  // ---------- lights ----------

  pickLights(target = {}) {
    const all = Object.values(this.config.lights);
    if (target.all) return all;
    const ids = new Set([].concat(target.ids || [], target.id || []));
    const rooms = new Set([].concat(target.rooms || [], target.room || []));
    return all.filter((l) => ids.has(l.id) || (l.room && rooms.has(l.room)));
  }

  // Applies a change to lights and sends it to their hubs. Returns the names
  // of lights whose hub is offline.
  applyLights(lights, change, { ms = 0, save = true } = {}) {
    const msg = {};
    if (change.on !== undefined) msg.on = !!change.on;
    if (change.bri != null) msg.bri = clamp(Math.round(change.bri), 1, 254);
    if (change.color) {
      const xy = hexToXy(change.color);
      if (!xy) throw err('That colour is not valid');
      msg.xy = xy;
    } else if (Array.isArray(change.xy) && change.xy.length === 2) {
      msg.xy = change.xy.map((v) => clamp(Number(v) || 0, 0, 1));
    } else if (change.ct != null) {
      msg.ct = clamp(Math.round(change.ct), 153, 500);
    }
    if (msg.bri != null && msg.on === undefined) msg.on = true;
    if ((msg.xy || msg.ct) && msg.on === undefined) msg.on = true;
    if (!Object.keys(msg).length) throw err('Nothing to change');

    const byHub = new Map();
    for (const l of lights) {
      if (msg.on !== undefined) l.on = msg.on;
      if (msg.bri != null) l.bri = msg.bri;
      if (msg.xy && l.caps?.xy !== false) {
        l.xy = msg.xy;
        l.mode = 'xy';
      }
      if (msg.ct && l.caps?.ct !== false) {
        l.ct = msg.ct;
        l.mode = 'ct';
      }
      if (!l.hub) continue;
      if (!byHub.has(l.hub)) byHub.set(l.hub, []);
      byHub.get(l.hub).push(l.id);
    }
    const offline = [];
    for (const [hub, ids] of byHub) {
      if (!this.hubs.send(hub, { t: 'set', ids, s: msg, ms: Math.max(0, Math.round(ms)) })) {
        offline.push(...ids.map((id) => this.config.lights[id]?.name || id));
      }
    }
    for (const l of lights) if (!l.hub) offline.push(l.name);
    if (save) this.save();
    return offline;
  }

  // Sets each light back to its own saved state (after a game). The hub
  // writes the colour first and the power last, so a light that was off
  // gets its old colour back and stays off.
  restoreLights(saved) {
    for (const [id, s] of Object.entries(saved || {})) {
      const l = this.config.lights[id];
      if (!l) continue;
      const change = { on: !!s.on, bri: s.bri };
      if (s.xy) change.xy = s.xy;
      else if (s.ct) change.ct = s.ct;
      this.applyLights([l], change, { ms: s.on ? 1500 : 0, save: false });
    }
  }

  control(body, by) {
    const lights = this.pickLights(body.target || body);
    if (!lights.length) throw err('No lights chosen');
    const fade = Math.max(0, Math.min(3600_000, Math.round(Number(body.ms) || 0)));
    const offline = this.applyLights(lights, body, { ms: fade, save: false });
    const what = body.target?.all || body.all ? 'all lights' : body.target?.room || body.room || (lights.length === 1 ? lights[0].name : `${lights.length} lights`);
    if (body.on === false) this.log(by, `Turned off ${what}`);
    else if (body.on === true && body.bri == null && !body.color && body.ct == null) this.log(by, `Turned on ${what}`);
    else this.log(by, `Changed ${what}`);
    this.save();
    return { offline };
  }

  updateLight({ id, name, room }, by) {
    const l = this.config.lights[id];
    if (!l) throw err('Light not found', 404);
    if (name !== undefined && text(name)) {
      const n = text(name);
      if (n !== l.name) {
        this.log(by, `Renamed ${l.name} to ${n}`);
        l.name = n;
        if (l.hub) this.hubs.send(l.hub, { t: 'rename', id, name: n });
      }
    }
    if (room !== undefined) {
      l.room = text(room) || '';
      if (l.room && !this.config.rooms.includes(l.room)) this.config.rooms.push(l.room);
    }
    this.save();
  }

  setRooms({ order, rename }, by) {
    if (rename?.from && text(rename.to)) {
      const to = text(rename.to);
      for (const l of Object.values(this.config.lights)) if (l.room === rename.from) l.room = to;
      this.config.rooms = this.config.rooms.map((r) => (r === rename.from ? to : r));
      for (const s of this.config.schedules) if (s.target.rooms) s.target.rooms = s.target.rooms.map((r) => (r === rename.from ? to : r));
      this.log(by, `Renamed room ${rename.from} to ${to}`);
    }
    if (Array.isArray(order)) this.config.rooms = [...new Set(order.map((r) => text(r)).filter(Boolean))];
    // Drop rooms with no lights.
    const used = new Set(Object.values(this.config.lights).map((l) => l.room));
    this.config.rooms = this.config.rooms.filter((r) => used.has(r));
    this.save();
  }

  forgetLight(id, by) {
    const l = this.config.lights[id];
    if (!l) throw err('Light not found', 404);
    if (l.hub) this.hubs.send(l.hub, { t: 'forget', id });
    delete this.config.lights[id];
    this.config.chiefs.lights = this.config.chiefs.lights.filter((x) => x !== id);
    this.log(by, `Removed ${l.name}`);
    this.save();
  }

  identify(id) {
    const l = this.config.lights[id];
    if (!l) throw err('Light not found', 404);
    if (!l.hub || !this.hubs.send(l.hub, { t: 'fx', ids: [id], steps: buildEffect('identify') })) throw err('Its hub is offline');
  }

  // ---------- finding and pairing lights ----------

  startScan({ hub, all = false } = {}, by) {
    const online = this.hubs.online().filter((id) => this.config.hubs[id]);
    const targets = hub ? online.filter((h) => h === hub) : online;
    if (!targets.length) throw err(Object.keys(this.config.hubs).length ? 'No hub is online' : 'Set up a hub first');
    const sec = 30;
    for (const h of targets) this.hubs.send(h, { t: 'scan', sec, all: !!all });
    this.scanState = { ...this.scanState, until: this.now() + sec * 1000, found: [] };
    this.saveScan();
    this.log(by, 'Searched for lights');
  }

  stopScan() {
    for (const h of this.hubs.online()) if (this.config.hubs[h]) this.hubs.send(h, { t: 'scan', sec: 0 });
    this.scanState.until = 0;
    this.saveScan();
  }

  pair({ id, name, room }, by) {
    const f = this.scanState.found.find((x) => x.id === id);
    const hub = f?.hub || this.config.lights[id]?.hub;
    if (!hub) throw err('Search for lights first');
    if (!this.hubs.send(hub, { t: 'pair', id, addrType: f?.addrType ?? null })) throw err('That hub is offline');
    this.scanState.until = Math.min(this.scanState.until, this.now()); // the hub stops searching to pair
    if (f) {
      f.status = 'pairing';
      f.error = null;
      f.wantName = text(name) || null;
      f.wantRoom = text(room) || null;
    }
    this.saveScan();
    this.log(by, `Pairing ${text(name) || f?.name || id}`);
  }

  // ---------- hubs ----------

  // A hub is connecting. Returns 'ok' (known hub, right token) or 'pending'
  // (needs approving in the app).
  hubConnect(id, token, fw) {
    const h = this.config.hubs[id];
    if (h && token && token === h.token) {
      if (fw && h.fw !== fw) {
        h.fw = fw;
        this.save();
      }
      return 'ok';
    }
    const pending = this.config.pendingHubs;
    if (!pending[id]) {
      pending[id] = { since: this.now(), fw: fw || null };
      // Keep only a few, oldest first out.
      const ids = Object.keys(pending).sort((a, b) => pending[a].since - pending[b].since);
      while (ids.length > 3) delete pending[ids.shift()];
      this.save();
    }
    return 'pending';
  }

  approveHub(id, by) {
    if (!this.config.pendingHubs[id]) throw err('That hub is not waiting', 404);
    const token = randomId(24);
    const old = this.config.hubs[id];
    this.config.hubs[id] = { name: old?.name || `Hub ${id.slice(-5)}`, token, fw: this.config.pendingHubs[id].fw, approvedAt: this.now() };
    delete this.config.pendingHubs[id];
    // The hub saves the token and reconnects with it.
    this.hubs.send(id, { t: 'welcome', token });
    this.hubs.close(id, 4001, 'approved');
    this.log(by, `Added ${this.config.hubs[id].name}`);
    this.save();
  }

  rejectHub(id) {
    delete this.config.pendingHubs[id];
    this.hubs.close(id, 4003, 'rejected');
    this.save();
  }

  renameHub({ id, name }, by) {
    const h = this.config.hubs[id];
    if (!h || !text(name)) throw err('Hub not found', 404);
    h.name = text(name);
    this.save();
  }

  forgetHub(id, by) {
    const h = this.config.hubs[id];
    if (!h) throw err('Hub not found', 404);
    delete this.config.hubs[id];
    for (const l of Object.values(this.config.lights)) if (l.hub === id) (l.connected = false), (l.unpaired = true);
    this.hubs.close(id, 4003, 'removed');
    this.log(by, `Removed ${h.name}`);
    this.save();
  }

  hubGone() {
    // Reachability is worked out from which hubs are online, so nothing to save.
  }

  #adoptLight(hub, info) {
    const id = String(info.id || '').toLowerCase();
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(id)) return null;
    let l = this.config.lights[id];
    if (!l) {
      l = this.config.lights[id] = {
        id,
        name: text(info.name) || 'Hue light',
        room: '',
        hub,
        model: text(info.model, 40) || '',
        caps: { xy: true, ct: true },
        on: false,
        bri: 254,
        xy: null,
        ct: 366,
        mode: 'ct',
        connected: false,
        unpaired: false,
        addedAt: this.now(),
      };
    }
    l.hub = hub;
    l.unpaired = false;
    if (info.model) l.model = text(info.model, 40);
    if (info.caps) l.caps = { xy: info.caps.xy !== false, ct: info.caps.ct !== false };
    if (info.connected !== undefined) l.connected = !!info.connected;
    l.standby = !!info.standby;
    this.#takeState(l, info);
    return l;
  }

  #takeState(l, s) {
    if (s.on !== undefined) l.on = !!s.on;
    if (Number.isFinite(s.bri)) l.bri = clamp(s.bri, 1, 254);
    if (Array.isArray(s.xy)) {
      l.xy = s.xy;
      if (s.mode !== 'ct') l.mode = 'xy';
    }
    if (Number.isFinite(s.ct)) {
      l.ct = s.ct;
      if (s.mode === 'ct' || !Array.isArray(s.xy)) l.mode = 'ct';
    }
    if (s.mode === 'ct' || s.mode === 'xy') l.mode = s.mode;
  }

  onHubMessage(hub, msg) {
    if (!this.config.hubs[hub] || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        const seen = new Set();
        for (const info of msg.lights || []) {
          const l = this.#adoptLight(hub, info);
          if (l) seen.add(l.id);
        }
        for (const l of Object.values(this.config.lights)) {
          if (l.hub === hub && !seen.has(l.id)) (l.connected = false), (l.unpaired = true);
        }
        if (msg.fw) this.config.hubs[hub].fw = String(msg.fw).slice(0, 20);
        this.save();
        // Bring a hub that restarted mid-game back to the game colours.
        if (this.game.active) {
          const ids = this.gameLightIds().filter((id) => this.config.lights[id]?.hub === hub);
          if (ids.length) this.hubs.send(hub, { t: 'set', ids, s: this.gameBase(), ms: 0 });
        }
        break;
      }
      case 'light': {
        const l = this.config.lights[String(msg.id || '').toLowerCase()];
        if (!l || l.hub !== hub) break;
        const before = JSON.stringify([l.connected, l.standby, lightState(l)]);
        if (msg.connected !== undefined) l.connected = !!msg.connected;
        l.standby = !!msg.standby;
        this.#takeState(l, msg);
        if (JSON.stringify([l.connected, l.standby, lightState(l)]) !== before) this.save();
        break;
      }
      case 'found': {
        const id = String(msg.id || '').toLowerCase();
        if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(id)) break;
        const found = this.scanState.found;
        const f = found.find((x) => x.id === id);
        const rssi = Number(msg.rssi) || -100;
        const hue = msg.hue !== false; // older hubs only report Hue lights
        if (f) {
          if (rssi > f.rssi) Object.assign(f, { rssi, hub, addrType: msg.addrType ?? f.addrType });
          if (hue && !f.hue) Object.assign(f, { hue: true, name: text(msg.name) || f.name });
        } else {
          const entry = { id, name: text(msg.name) || 'Hue light', rssi, hub, addrType: msg.addrType ?? null, hue, status: 'found', error: null };
          if (found.length < 40) found.push(entry);
          else if (hue) {
            // Full: make room for a Hue light by dropping the weakest other device.
            const others = found.filter((x) => !x.hue).sort((a, b) => a.rssi - b.rssi);
            if (others.length) found.splice(found.indexOf(others[0]), 1, entry);
          }
        }
        this.saveScan();
        break;
      }
      case 'paired': {
        const id = String(msg.id || '').toLowerCase();
        const f = this.scanState.found.find((x) => x.id === id);
        if (msg.ok) {
          const l = this.#adoptLight(hub, { ...msg, connected: true });
          if (l && f?.wantName) {
            l.name = f.wantName;
            this.hubs.send(hub, { t: 'rename', id, name: l.name });
          }
          if (l && f?.wantRoom) {
            l.room = f.wantRoom;
            if (!this.config.rooms.includes(l.room)) this.config.rooms.push(l.room);
          }
          if (f) f.status = 'paired';
          if (l) this.log(null, `Paired ${l.name}`);
          this.save();
        } else if (f) {
          f.status = 'failed';
          f.error = text(msg.error, 400) || 'Pairing failed';
        }
        this.saveScan();
        break;
      }
      case 'scanDone':
        this.scanState.until = Math.min(this.scanState.until, this.now());
        this.saveScan();
        break;
      case 'log': {
        const log = (this.scanState.log ||= []);
        log.unshift({ at: this.now(), hub, text: text(msg.text, 300) });
        log.length = Math.min(log.length, 30);
        this.saveScan();
        break;
      }
    }
  }

  // ---------- schedules ----------

  setSchedules(list, by) {
    if (!Array.isArray(list)) throw err('Expected a list of schedules');
    if (list.length > 50) throw err('Too many schedules');
    this.config.schedules = list.map((s) => cleanEntry(s, () => randomId(6)));
    this.log(by, 'Updated schedules');
    this.save();
  }

  runSchedule(entry, by) {
    const lights = this.pickLights(entry.target).filter((l) => !(this.game.active && this.gameLightIds().includes(l.id)));
    if (!lights.length) return;
    const a = entry.action;
    const ms = (a.fade || 0) * MIN;
    if (a.power === 'off') {
      this.applyLights(lights, { on: false }, { ms, save: false });
    } else {
      const change = { on: true };
      if (a.bri != null) change.bri = a.bri;
      if (a.color) change.color = a.color;
      else if (a.ct != null) change.ct = a.ct;
      this.applyLights(lights, change, { ms, save: false });
    }
    this.log(by, `Ran schedule “${entry.name}”`);
  }

  runSchedulesDue(now) {
    const from = Math.max(this.schedFrom || 0, now - 15 * MIN);
    const due = runsBetween(this.config.schedules, from, now, this.tz, this.loc);
    this.schedFrom = now;
    if (!due.length) return;
    for (const { entry } of due) this.runSchedule(entry, null);
    this.config.schedCheckedAt = now;
    this.save();
  }

  // ---------- Chiefs mode ----------

  gameLightIds() {
    const all = Object.keys(this.config.lights);
    const chosen = this.config.chiefs.lights.filter((id) => this.config.lights[id]);
    return chosen.length ? chosen : all;
  }

  colors() {
    const us = this.game.event?.us;
    return {
      primary: us?.color && us.id !== '12' ? us.color : KC.primary,
      secondary: us?.alt && us.id !== '12' ? us.alt : KC.secondary,
      opp: this.game.event?.opp?.color || '#ffffff',
      bri: this.config.chiefs.bri,
    };
  }

  gameBase() {
    return { on: true, bri: this.config.chiefs.bri, xy: hexToXy(this.colors().primary) };
  }

  setChiefs(patch, by) {
    const c = this.config.chiefs;
    const wasEnabled = c.enabled;
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (Array.isArray(patch.lights)) c.lights = patch.lights.filter((id) => this.config.lights[id]);
    if (patch.bri != null) c.bri = clamp(Math.round(patch.bri), 1, 254);
    if (patch.pregameMin != null) c.pregameMin = clamp(Math.round(patch.pregameMin), 0, 240);
    if (patch.postgameMin != null) c.postgameMin = clamp(Math.round(patch.postgameMin), 0, 240);
    if (patch.afterGame === 'restore' || patch.afterGame === 'stay') c.afterGame = patch.afterGame;
    if (patch.delaySec != null) c.delaySec = clamp(Math.round(patch.delaySec), 0, 180);
    if (patch.pollSec != null) c.pollSec = clamp(Math.round(patch.pollSec), 5, 60);
    if (patch.events && typeof patch.events === 'object') {
      for (const k of Object.keys(EVENTS)) if (patch.events[k] !== undefined) c.events[k] = !!patch.events[k];
    }
    if (wasEnabled !== c.enabled) {
      this.log(by, c.enabled ? 'Turned on Chiefs mode' : 'Turned off Chiefs mode');
      this.game.nextCheck = 0; // look for a game right away
    }
    if (this.game.active && (patch.bri != null || Array.isArray(patch.lights))) {
      this.#paintGameLights();
    }
    this.save();
    this.saveGame();
  }

  #paintGameLights() {
    const lights = this.gameLightIds().map((id) => this.config.lights[id]);
    this.applyLights(lights, this.gameBase(), { ms: 1500, save: false });
  }

  startGameMode(by, { manual = false } = {}) {
    const g = this.game;
    if (!g.active) {
      g.saved = {};
      for (const id of this.gameLightIds()) g.saved[id] = lightState(this.config.lights[id]);
      g.active = true;
    }
    g.manual = manual || g.manual;
    this.#paintGameLights();
    const name = g.event ? g.event.name : 'Chiefs colours';
    this.log(by, `Game mode on${g.event ? `: ${name}` : ''}`);
    this.save();
    this.saveGame();
  }

  endGameMode(by, why = 'Game mode off') {
    const g = this.game;
    if (g.active && g.saved) this.restoreLights(g.saved);
    g.active = false;
    g.manual = false;
    g.saved = null;
    g.restoreAt = null;
    g.queue = [];
    if (g.phase !== 'live' && g.phase !== 'pregame') g.phase = g.event && g.doneId !== g.event.id ? 'scheduled' : 'idle';
    this.log(by, why);
    this.save();
    this.saveGame();
  }

  playEffect(kind) {
    const frames = buildEffect(kind, this.colors());
    if (!frames) throw err('Unknown effect');
    const ids = this.gameLightIds();
    const byHub = new Map();
    for (const id of ids) {
      const l = this.config.lights[id];
      if (!l?.hub) continue;
      if (!byHub.has(l.hub)) byHub.set(l.hub, []);
      byHub.get(l.hub).push(id);
    }
    let sent = false;
    for (const [hub, list] of byHub) sent = this.hubs.send(hub, { t: 'fx', ids: list, steps: frames }) || sent;
    return { sent, ms: effectLength(frames) };
  }

  testEffect(kind, by) {
    if (!EVENTS[kind]) throw err('Unknown event');
    const { sent } = this.playEffect(kind);
    if (!sent) throw err('No hub is online');
    this.#feed({ kind, label: `Test: ${EVENTS[kind].label}`, text: '', at: this.now() });
    this.saveGame();
  }

  #feed(item) {
    this.game.recent.unshift(item);
    this.game.recent.length = Math.min(this.game.recent.length, 12);
  }

  async refreshGame() {
    this.game.nextCheck = 0;
    this.game.nextPoll = 0;
    await this.chiefsTick(this.now());
  }

  async chiefsTick(now) {
    const c = this.config.chiefs;
    const g = this.game;
    if (!c.enabled) {
      if (g.active && !g.manual) this.endGameMode(null, 'Chiefs mode is off');
      if (g.phase !== 'idle' || g.event) {
        Object.assign(g, { phase: 'idle', event: null, queue: [], error: null });
        this.saveGame();
      }
      return;
    }

    let changed = false;

    // 1. Look for this week's game.
    if (now >= (g.nextCheck || 0) && g.phase !== 'live') {
      try {
        const ev = findGame(await this.fetchJson(`${ESPN}/scoreboard`), c.teamId);
        g.error = null;
        if (ev && ev.id !== g.doneId) {
          if (g.event?.id !== ev.id) Object.assign(g, { seq: null, prev: { home: 0, away: 0 }, score: null, lastPlay: null, recent: [] });
          g.event = ev;
          g.detail = ev.detail;
          if (g.phase === 'idle' || g.phase === 'final') g.phase = 'scheduled';
        } else if (!ev && !g.active) {
          g.event = null;
          g.phase = 'idle';
        }
        g.nextCheck = now + 6 * HOUR;
      } catch (e) {
        g.error = `Couldn’t check the NFL schedule: ${e.message}`;
        g.nextCheck = now + 15 * MIN;
      }
      changed = true;
    }

    // 2. Before kickoff: lights to team colours. From just before kickoff:
    // follow the game play by play.
    const ev = g.event;
    if (ev && g.phase !== 'final') {
      if (!g.active && now >= ev.start - c.pregameMin * MIN && now < ev.start + 6 * HOUR) {
        this.startGameMode(null);
        if (g.phase === 'scheduled') g.phase = 'pregame';
        changed = true;
      }
      if (now >= ev.start - 10 * MIN && now >= (g.nextPoll || 0)) {
        await this.#pollGame(now);
        changed = true;
      }
    }

    // 3. Effects that were waiting for the TV to catch up.
    if (this.#runQueue(now)) changed = true;

    // 4. After the game.
    if (g.restoreAt && now >= g.restoreAt) {
      this.endGameMode(null, 'Game over: lights back to normal');
      changed = true;
    }

    if (changed) this.saveGame();
  }

  async #pollGame(now) {
    const c = this.config.chiefs;
    const g = this.game;
    const ev = g.event;
    let s;
    try {
      s = parseSummary(await this.fetchJson(`${ESPN}/summary?event=${ev.id}`));
      g.error = null;
    } catch (e) {
      g.error = `Couldn’t read the game: ${e.message}`;
      g.nextPoll = now + 30 * 1000;
      return;
    }
    g.detail = s.detail || g.detail;
    g.score = { us: s.scores[ev.us.id] ?? 0, opp: s.scores[ev.opp.id] ?? 0, period: s.period, clock: s.clock };

    const last = s.plays[s.plays.length - 1];
    if (g.seq == null) {
      // First look at this game: start from here, don't replay old plays.
      g.seq = last ? Number(last.sequenceNumber) : 0;
      g.prev = last ? { home: +last.homeScore || 0, away: +last.awayScore || 0 } : { home: 0, away: 0 };
    } else {
      for (const p of s.plays) {
        if (Number(p.sequenceNumber) <= g.seq) continue;
        g.seq = Number(p.sequenceNumber);
        const r = classifyPlay(p, { teamId: ev.us.id, home: ev.home, prev: g.prev });
        g.prev = r.after;
        const kind = pickEvent(r.events, c.events);
        if (!kind) continue;
        const wall = Date.parse(p.wallclock) || now;
        const at = Math.max(now, wall + c.delaySec * 1000);
        // Catching up after a gap: show it in the feed, but don't flash
        // lights for plays the TV showed more than a minute ago.
        if (wall + c.delaySec * 1000 >= now - MIN) g.queue.push({ kind, at });
        this.#feed({ kind, label: describe(kind, { penaltyOn: r.penaltyOn, us: ev.us, opp: ev.opp }), text: String(p.text || '').slice(0, 200), at: wall });
      }
    }
    if (last) g.lastPlay = { text: String(last.text || '').slice(0, 200), wall: Date.parse(last.wallclock) || null, seenAt: now };

    if (s.state === 'post' || s.completed) {
      g.phase = 'final';
      g.doneId = ev.id;
      const won = g.score.us > g.score.opp;
      const kind = won ? 'win' : g.score.us < g.score.opp ? 'loss' : null;
      if (kind && c.events[kind]) {
        g.queue.push({ kind, at: now + c.delaySec * 1000 });
        this.#feed({ kind, label: describe(kind, { us: ev.us }), text: `${ev.us.abbr} ${g.score.us} – ${g.score.opp} ${ev.opp.abbr}`, at: now });
      }
      if (g.active && !g.manual) {
        if (c.afterGame === 'restore') g.restoreAt = now + c.delaySec * 1000 + c.postgameMin * MIN;
        else Object.assign(g, { active: false, saved: null });
      }
      g.nextCheck = now + 6 * HOUR;
      g.nextPoll = 0;
      this.log(null, `Final: ${ev.us.abbr} ${g.score.us}, ${ev.opp.abbr} ${g.score.opp}`);
      this.save();
      return;
    }
    g.phase = s.state === 'in' ? 'live' : g.active ? 'pregame' : 'scheduled';
    // Play by play once it's close to kickoff (ESPN can flip to "in" late).
    g.nextPoll = now + (s.state === 'in' || now >= ev.start - 2 * MIN ? c.pollSec * 1000 : 60 * 1000);
  }

  // Plays due effects one after another. Returns true if anything changed.
  #runQueue(now) {
    const g = this.game;
    if (!g.queue.length) return false;
    g.queue.sort((a, b) => a.at - b.at);
    let changed = false;
    while (g.queue.length && g.queue[0].at <= now) {
      if (g.busyUntil > now) {
        g.queue[0].at = g.busyUntil;
        break;
      }
      const item = g.queue.shift();
      changed = true;
      const final = item.kind === 'win' || item.kind === 'loss';
      if (!final && (!g.active || now - item.at > 90 * 1000)) continue; // too late to be fun
      const { ms } = this.playEffect(item.kind);
      g.busyUntil = now + ms;
    }
    return changed || g.queue.length > 0;
  }

  // ---------- settings ----------

  setSettings(patch, by) {
    const s = this.config.settings;
    if (patch.tz !== undefined) {
      if (!isValidTimeZone(patch.tz)) throw err('Unknown time zone');
      s.tz = patch.tz;
    }
    if (patch.lat !== undefined || patch.lon !== undefined) {
      const lat = Number(patch.lat);
      const lon = Number(patch.lon);
      if (patch.lat === null) Object.assign(s, { lat: null, lon: null });
      else if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        // About 1 km precision is plenty for sunset times.
        s.lat = Math.round(lat * 100) / 100;
        s.lon = Math.round(lon * 100) / 100;
      } else throw err('That location is not valid');
    }
    if (patch.place !== undefined) s.place = text(patch.place, 60);
    this.log(by, 'Changed settings');
    this.save();
  }

  // ---------- the clock ----------

  async tick() {
    const now = this.now();
    this.runSchedulesDue(now);
    await this.chiefsTick(now);
  }

  // When the house next needs to wake up (ms), or null.
  nextWake() {
    const now = this.now();
    const times = [];
    const next = nextRun(this.config.schedules, now, this.tz, this.loc);
    if (next) times.push(next.at);
    const g = this.game;
    const c = this.config.chiefs;
    if (c.enabled) {
      times.push(g.nextCheck || now);
      const ev = g.event;
      if (ev && g.phase !== 'final') {
        if (!g.active) times.push(ev.start - c.pregameMin * MIN);
        times.push(Math.max(ev.start - 10 * MIN, g.nextPoll || 0));
      }
    }
    if (g.queue.length) times.push(Math.min(...g.queue.map((q) => Math.max(q.at, g.busyUntil || 0))));
    if (g.restoreAt) times.push(g.restoreAt);
    const at = Math.min(...times.filter(Number.isFinite));
    return Number.isFinite(at) ? Math.max(at, now + 1000) : null;
  }
}
