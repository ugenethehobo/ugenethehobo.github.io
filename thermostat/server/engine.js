import { EventEmitter } from 'node:events';
import { commandsFor, decide, measure } from './controller.js';
import { effectiveProgram, nextChange } from './schedule.js';
import { logActivity, saveStore } from './store.js';

const MODES = ['off', 'heat', 'cool', 'smart'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ASSUME_MS = 90 * 1000; // trust a sent command until Amazon's state catches up
const MODE_LABEL = { off: 'Off', heat: 'Heat', cool: 'Cool', smart: 'Smart' };

export class Engine extends EventEmitter {
  constructor(driver, store, { log = console } = {}) {
    super();
    this.driver = driver;
    this.store = store;
    this.log = log;
    this.devices = { thermostats: [], sensors: [], fan: { supported: false, modes: [] } };
    this.readings = {};
    this.assumed = {};
    this.status = { action: 'unknown', reason: 'Starting up…' };
    this.commands = []; // recent commands, newest first, for the UI
    this.lastPollAt = 0;
    this.pollError = null;
    this.chain = Promise.resolve();
    this.pollTimer = null;
    this.failures = 0;
    this.lastDiscovery = 0;
  }

  get thermostatId() {
    return this.store.settings.thermostatId;
  }

  async start() {
    this.driver.on?.('status', () => this.emit('update'));
    this.driver.on?.('reconnected', () => this.#schedulePoll(1000));
    await this.driver.connect();
    this.emit('update');
    this.#schedulePoll(0);
  }

  async discover() {
    const d = await this.driver.discover();
    const s = this.store.settings;
    if (!s.thermostatId || !d.thermostats.some((t) => t.id === s.thermostatId)) {
      s.thermostatId = d.thermostats[0]?.id || null;
    }
    const fan = s.thermostatId ? this.driver.useThermostat(s.thermostatId) : { supported: false, modes: [] };
    this.devices = { thermostats: d.thermostats, sensors: d.sensors, fan };
    if (!this.store.base.sensors.length && s.thermostatId) this.store.base.sensors = [s.thermostatId];
    if (fan.supported && !fan.modes.some((m) => m.value === this.store.base.fan)) {
      this.store.base.fan = fan.modes[0].value;
    }
    this.lastDiscovery = Date.now();
    saveStore(this.store);
    return this.devices;
  }

  #schedulePoll(ms) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll().catch(() => {}), ms);
  }

  // Serialize all work so two changes can't race each other to the thermostat.
  #serial(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  poll() {
    return this.#serial(async () => {
      const base = (this.store.settings.pollSeconds || 60) * 1000;
      try {
        if (this.driver.status().state !== 'connected') {
          this.#schedulePoll(5000);
          return;
        }
        if (!this.lastDiscovery || Date.now() - this.lastDiscovery > 6 * 3600 * 1000) await this.discover();
        const readings = await this.driver.poll();
        this.readings = { ...this.readings, ...readings };
        this.lastPollAt = Date.now();
        this.pollError = null;
        this.failures = 0;
        this.#reconcileAssumed();
        await this.#evaluate();
        this.#schedulePoll(base);
      } catch (err) {
        this.failures += 1;
        this.pollError = err.message || String(err);
        this.log.error('Poll failed:', this.pollError);
        this.#schedulePoll(Math.min(base * 2 ** this.failures, 5 * 60 * 1000));
      } finally {
        this.emit('update');
      }
    });
  }

  thermostatState() {
    const r = this.readings[this.thermostatId] || {};
    const now = Date.now();
    const t = { id: this.thermostatId, temp: r.temp, mode: r.mode, setpoint: r.setpoint, fan: r.fan, fanSupported: this.devices.fan.supported };
    for (const [k, a] of Object.entries(this.assumed)) if (a.until > now) t[k] = a.value;
    return t;
  }

  #reconcileAssumed() {
    const r = this.readings[this.thermostatId] || {};
    const now = Date.now();
    for (const [k, a] of Object.entries(this.assumed)) {
      const seen = r[k];
      const match = k === 'setpoint' ? Math.abs(seen - a.value) < 0.6 : seen === a.value;
      if (match) {
        for (const c of this.commands) if (c.field === k && c.value === a.value && c.state === 'sent') c.state = 'confirmed';
        delete this.assumed[k];
      } else if (a.until <= now) {
        delete this.assumed[k];
      }
    }
  }

  #expireOverride(now) {
    const o = this.store.override;
    if (o && o.until && o.until <= now) {
      this.store.override = null;
      logActivity(this.store, 'Schedule', 'Manual hold ended, back on schedule');
      saveStore(this.store);
    }
  }

  async #evaluate() {
    const now = Date.now();
    this.#expireOverride(now);
    if (!this.thermostatId) {
      this.status = { action: 'unknown', reason: 'No thermostat found on this Amazon account' };
      return [];
    }
    const eff = effectiveProgram(this.store, new Date(now));
    const measured = measure(eff.program, this.readings, this.thermostatId, this.store.settings, now);
    const thermostat = this.thermostatState();
    const d = decide({ program: eff.program, measured, thermostat, runtime: this.store.runtime, settings: this.store.settings, now });
    this.store.runtime = d.runtime;
    this.status = {
      action: d.action,
      reason: d.reason,
      driven: d.driven,
      inferred: !!d.inferred,
      measured: measured.temp,
      used: measured.used,
      stale: measured.stale,
      fallback: measured.fallback && eff.program.sensors?.some((s) => s !== this.thermostatId),
    };
    const cmds = commandsFor(d.want, thermostat, eff.program);
    const results = [];
    // Mode first: a set point only applies to the thermostat's current mode.
    for (const field of ['mode', 'setpoint', 'fan']) {
      if (cmds[field] === undefined) continue;
      results.push(await this.#send(field, cmds[field]));
    }
    if (results.length) {
      saveStore(this.store);
      // Read back shortly so the UI can show "confirmed by thermostat".
      this.#schedulePoll(5000);
    }
    return results;
  }

  async #send(field, value) {
    const cmd = { id: Math.random().toString(36).slice(2), field, value, state: 'sending', at: Date.now() };
    this.commands.unshift(cmd);
    this.commands.length = Math.min(this.commands.length, 10);
    this.emit('update');
    try {
      if (field === 'mode') await this.driver.setMode(value);
      if (field === 'setpoint') await this.driver.setSetpoint(value);
      if (field === 'fan') await this.driver.setFan(value);
      cmd.state = 'sent';
      this.assumed[field] = { value, until: Date.now() + ASSUME_MS };
    } catch (err) {
      cmd.state = 'failed';
      cmd.error = err.message || String(err);
      this.log.error(`Command ${field}=${value} failed:`, cmd.error);
    }
    this.emit('update');
    return cmd;
  }

  // ---- changes from people -------------------------------------------------

  validateProgram(p, { partial = true } = {}) {
    const s = this.store.settings;
    const out = {};
    if (p.mode !== undefined) {
      if (!MODES.includes(p.mode)) throw new Error('Unknown mode');
      out.mode = p.mode;
    }
    if (p.target !== undefined) {
      const t = Number(p.target);
      if (!Number.isFinite(t)) throw new Error('Bad temperature');
      out.target = Math.min(s.maxTarget, Math.max(s.minTarget, Math.round(t * 2) / 2));
    }
    if (p.fan !== undefined) {
      const modes = this.devices.fan.modes.map((m) => m.value);
      if (modes.length && !modes.includes(p.fan)) throw new Error('Unknown fan setting');
      out.fan = p.fan;
    }
    if (p.sensors !== undefined) {
      const known = new Set(this.devices.sensors.map((x) => x.id));
      const list = [...new Set(Array.isArray(p.sensors) ? p.sensors : [])].filter((id) => known.has(id) || !known.size);
      if (!list.length) throw new Error('Pick at least one sensor');
      out.sensors = list;
    }
    if (!partial) for (const k of ['mode', 'target', 'sensors']) if (out[k] === undefined) throw new Error(`Missing ${k}`);
    return out;
  }

  control(changes, by) {
    return this.#serial(async () => {
      const clean = this.validateProgram(changes);
      if (!Object.keys(clean).length) return [];
      const now = Date.now();
      const { schedule } = this.store;
      const describe = this.#describe(clean);
      if (schedule.enabled && schedule.entries.length) {
        const next = nextChange(schedule.entries, new Date(now));
        this.store.override = { ...(this.store.override || {}), ...clean, until: next ? next.at : null, by, at: now };
        logActivity(this.store, by, `${describe} (hold until next schedule change)`);
      } else {
        Object.assign(this.store.base, clean);
        logActivity(this.store, by, describe);
      }
      saveStore(this.store);
      const results = await this.#evaluate();
      this.emit('update');
      return results;
    });
  }

  resume(by) {
    return this.#serial(async () => {
      if (!this.store.override) return [];
      this.store.override = null;
      logActivity(this.store, by, 'Resumed the schedule');
      saveStore(this.store);
      const results = await this.#evaluate();
      this.emit('update');
      return results;
    });
  }

  setSchedule(input, by) {
    return this.#serial(async () => {
      const entries = (input.entries || []).map((e) => {
        if (!/^\d{1,2}:\d{2}$/.test(e.time)) throw new Error('Bad time');
        const days = [...new Set((e.days || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
        if (!days.length) throw new Error('Pick at least one day');
        return {
          id: String(e.id || Math.random().toString(36).slice(2)),
          name: String(e.name || '').slice(0, 40),
          time: e.time.padStart(5, '0'),
          days,
          ...this.validateProgram(e, { partial: false }),
        };
      });
      const seen = new Set();
      for (const e of entries) {
        for (const d of e.days) {
          const key = `${d} ${e.time}`;
          if (seen.has(key)) throw new Error(`Two times are set for ${DAY_NAMES[d]} at ${e.time}. Edit the existing one instead.`);
          seen.add(key);
        }
      }
      const wasEnabled = this.store.schedule.enabled;
      const enabled = input.enabled !== undefined ? !!input.enabled : wasEnabled;
      if (wasEnabled && !enabled) {
        // Keep whatever is running now as the new manual setting.
        const eff = effectiveProgram(this.store);
        Object.assign(this.store.base, eff.program);
        this.store.override = null;
      }
      this.store.schedule = { enabled, entries };
      if (this.store.override) {
        const next = nextChange(entries);
        this.store.override.until = next ? next.at : null;
      }
      logActivity(this.store, by, enabled === wasEnabled ? 'Edited the schedule' : enabled ? 'Turned the schedule on' : 'Turned the schedule off');
      saveStore(this.store);
      const results = await this.#evaluate();
      this.emit('update');
      return results;
    });
  }

  setSettings(input, by) {
    return this.#serial(async () => {
      const s = this.store.settings;
      const num = (v, lo, hi) => {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error('Bad number');
        return Math.min(hi, Math.max(lo, n));
      };
      if (input.unit !== undefined) s.unit = input.unit === 'C' ? 'C' : 'F';
      if (input.swing !== undefined) s.swing = num(input.swing, 0.25, 3);
      if (input.maxOffset !== undefined) s.maxOffset = num(input.maxOffset, 2, 10);
      if (input.pollSeconds !== undefined) s.pollSeconds = num(input.pollSeconds, 30, 600);
      if (input.smart?.threshold !== undefined) s.smart.threshold = num(input.smart.threshold, 0.5, 5);
      if (input.smart?.changeoverDelayMin !== undefined) s.smart.changeoverDelayMin = num(input.smart.changeoverDelayMin, 0, 60);
      if (input.sensorNames) {
        for (const [id, name] of Object.entries(input.sensorNames)) {
          if (name) s.sensorNames[id] = String(name).slice(0, 30);
          else delete s.sensorNames[id];
        }
      }
      if (input.thermostatId !== undefined && this.devices.thermostats.some((t) => t.id === input.thermostatId)) {
        s.thermostatId = input.thermostatId;
        this.devices.fan = this.driver.useThermostat(s.thermostatId);
      }
      logActivity(this.store, by, 'Changed settings');
      saveStore(this.store);
      const results = await this.#evaluate();
      this.emit('update');
      return results;
    });
  }

  refresh() {
    if (Date.now() - this.lastPollAt < 5000) return Promise.resolve();
    return this.poll();
  }

  #sensorName(id) {
    return this.store.settings.sensorNames[id] || this.devices.sensors.find((s) => s.id === id)?.name || 'sensor';
  }

  #describe(c) {
    const parts = [];
    if (c.mode) parts.push(`mode ${MODE_LABEL[c.mode]}`);
    if (c.target !== undefined) {
      const t = this.store.settings.unit === 'C' ? Math.round(((c.target - 32) / 1.8) * 2) / 2 : c.target;
      parts.push(`${t}°`);
    }
    if (c.fan) parts.push(`fan ${this.devices.fan.modes.find((m) => m.value === c.fan)?.label || c.fan}`);
    if (c.sensors) parts.push(`using ${c.sensors.map((id) => this.#sensorName(id)).join(' + ')}`);
    return `Set ${parts.join(', ')}`;
  }

  // ---- what the app sees ---------------------------------------------------

  snapshot() {
    const now = Date.now();
    const eff = effectiveProgram(this.store, new Date(now));
    const s = this.store.settings;
    return {
      serverTime: now,
      connection: { ...this.driver.status(), lastPollAt: this.lastPollAt, pollError: this.pollError, pollSeconds: s.pollSeconds },
      thermostat: { ...this.thermostatState(), name: this.devices.thermostats.find((t) => t.id === this.thermostatId)?.name },
      thermostats: this.devices.thermostats,
      fan: this.devices.fan,
      sensors: this.devices.sensors
        .filter((x) => !s.hiddenSensors.includes(x.id))
        .map((x) => ({ ...x, name: s.sensorNames[x.id] || x.name, originalName: x.name, ...this.readings[x.id] })),
      program: eff.program,
      source: eff.source,
      entry: eff.entry,
      override: eff.override,
      next: eff.next,
      base: this.store.base,
      schedule: this.store.schedule,
      settings: s,
      status: this.status,
      commands: this.commands.slice(0, 5),
      activity: this.store.activity.slice(0, 40),
    };
  }
}
