// Talks to Amazon's (private, undocumented) Alexa smart home API — the same
// endpoints the Alexa app uses — through the community `alexa-remote2`
// library. Everything Amazon-specific lives in this file.
//
//   discover: POST /nexus/v1/graphql           (device list + capabilities)
//   poll:     POST /api/phoenix/state          (current readings)
//   control:  PUT  /api/phoenix/state          (set mode / set point / fan)
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DATA_DIR, readJson, writeJson } from '../store.js';

const require = createRequire(import.meta.url);
const AlexaRemote = require('alexa-remote2');

const TIMEOUT_MS = 15000;

const toF = (v, scale) => {
  if (typeof v !== 'number') v = Number(v);
  if (!Number.isFinite(v)) return null;
  const s = String(scale || 'FAHRENHEIT').toUpperCase();
  if (s.startsWith('C')) return v * 1.8 + 32;
  if (s.startsWith('K')) return (v - 273.15) * 1.8 + 32;
  return v;
};
const fromF = (f, scale) => (String(scale).toUpperCase().startsWith('C') ? Math.round(((f - 32) / 1.8) * 2) / 2 : Math.round(f));

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function friendlyNames(cap) {
  const names = [];
  const res = cap.resources || cap.capabilityResources || {};
  for (const n of res.friendlyNames || []) {
    names.push(n.value?.text || n.value?.assetId || n.friendlyName || '');
  }
  return names.join(' ');
}

function labelFor(value) {
  const tail = String(value).split('.').pop();
  return tail.charAt(0).toUpperCase() + tail.slice(1).toLowerCase();
}

export class AlexaDriver extends EventEmitter {
  constructor({ logger = console } = {}) {
    super();
    this.log = logger;
    this.alexa = null;
    this.info = { state: 'connecting', message: 'Connecting to Amazon…' };
    this.devices = new Map(); // id -> { id, entityId, name, kind, caps, merged }
    this.thermostatId = null;
    this.fan = { supported: false, modes: [] };
    this.scale = 'FAHRENHEIT';
    this.queue = Promise.resolve();
    this.lastRaw = {};
  }

  status() {
    return this.info;
  }

  #setInfo(info) {
    this.info = info;
    this.emit('status', info);
  }

  connect() {
    const saved = readJson('amazon.json', null);
    const proxyHost = process.env.PROXY_HOST || 'localhost';
    const proxyPort = Number(process.env.PROXY_PORT) || 3457;
    const amazonPage = process.env.AMAZON_PAGE || 'amazon.com';
    this.alexa = new AlexaRemote();
    this.alexa.on('cookie', () => {
      if (this.alexa.cookieData) writeJson('amazon.json', this.alexa.cookieData);
    });
    if (!saved) {
      this.#setInfo({
        state: 'needs-login',
        message: 'Sign in to Amazon once to link your thermostat.',
        loginUrl: `http://${proxyHost}:${proxyPort}/`,
      });
    }
    return new Promise((resolve) => {
      let first = true;
      this.alexa.init(
        {
          cookie: saved || undefined,
          formerRegistrationData: saved || undefined,
          formerDataStorePath: path.join(DATA_DIR, 'alexa-former.json'),
          proxyOnly: true,
          setupProxy: true,
          proxyOwnIp: proxyHost,
          proxyPort,
          proxyListenBind: '0.0.0.0',
          proxyLogLevel: 'warn',
          amazonPage,
          alexaServiceHost: process.env.ALEXA_HOST || (amazonPage === 'amazon.com' ? 'pitangui.amazon.com' : `alexa.${amazonPage}`),
          acceptLanguage: process.env.ACCEPT_LANGUAGE || 'en-US',
          useWsMqtt: false,
          logger: process.env.DEBUG_ALEXA ? (m) => this.log.log(m) : undefined,
        },
        (err) => {
          // alexa-remote2 calls this again after every cookie refresh.
          if (err) {
            this.log.error('Amazon connection failed:', err.message || err);
            this.#setInfo({
              state: 'needs-login',
              message: /Please open/i.test(String(err.message || err))
                ? 'Sign in to Amazon once to link your thermostat.'
                : `Amazon sign-in needed (${err.message || err}).`,
              loginUrl: `http://${proxyHost}:${proxyPort}/`,
            });
          } else {
            if (this.alexa.cookieData) writeJson('amazon.json', this.alexa.cookieData);
            this.#setInfo({ state: 'connected', message: 'Connected to Amazon' });
          }
          if (first) {
            first = false;
            resolve(this.info);
          } else {
            this.emit('reconnected');
          }
        },
      );
    });
  }

  #call(method, ...args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Amazon did not respond in 15 s')), TIMEOUT_MS);
      this.alexa[method](...args, (err, res) => {
        clearTimeout(timer);
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(res);
      });
    });
  }

  async discover() {
    const items = await this.#call('getSmarthomeDevicesV2');
    this.devices.clear();
    this.lastRaw.discovery = items;
    const thermostats = [];
    const sensors = [];
    for (const item of items) {
      const a = item.legacyAppliance || {};
      const id = a.applianceId || item.endpointId || item.id;
      if (!id) continue;
      const caps = (parseMaybeJson(a.capabilities) || []).map(parseMaybeJson);
      const ifaces = new Set(caps.map((c) => c.interfaceName));
      const types = [...(a.applianceTypes || []), item.displayCategories?.primary?.value].filter(Boolean).map(String);
      const isThermostat = ifaces.has('Alexa.ThermostatController') || types.includes('THERMOSTAT');
      const hasTemp = ifaces.has('Alexa.TemperatureSensor');
      if (!isThermostat && !hasTemp) continue;
      const humidityCap = caps.find(
        (c) => c.interfaceName === 'Alexa.RangeController' && /humid/i.test(`${c.instance} ${friendlyNames(c)}`),
      );
      const dev = {
        id,
        entityId: a.entityId || id,
        name: a.friendlyName || item.friendlyName || id,
        kind: isThermostat ? 'thermostat' : types.some((t) => /AIR_QUALITY/i.test(t)) ? 'air-quality' : 'sensor',
        caps,
        merged: Array.isArray(a.mergedApplianceIds) ? a.mergedApplianceIds : [],
        humidityInstance: humidityCap?.instance || null,
      };
      this.devices.set(id, dev);
      if (isThermostat) thermostats.push({ id, name: dev.name });
      if (hasTemp || isThermostat) sensors.push({ id, name: dev.name, kind: dev.kind });
    }
    return { thermostats, sensors, fan: this.fan, modes: ['HEAT', 'COOL', 'AUTO', 'OFF'] };
  }

  // Look for a fan control on the chosen thermostat. Amazon exposes these as
  // generic Mode/Toggle controllers whose name mentions the fan.
  useThermostat(id) {
    this.thermostatId = id;
    const dev = this.devices.get(id);
    this.fan = { supported: false, modes: [] };
    if (!dev) return this.fan;
    for (const c of dev.caps) {
      const text = `${c.instance || ''} ${friendlyNames(c)}`;
      if (!/fan/i.test(text)) continue;
      if (c.interfaceName === 'Alexa.ModeController' && c.configuration?.supportedModes?.length) {
        this.fan = {
          supported: true,
          kind: 'mode',
          instance: c.instance,
          modes: c.configuration.supportedModes.map((m) => ({ value: m.value, label: labelFor(m.value) })),
        };
        break;
      }
      if (c.interfaceName === 'Alexa.ToggleController') {
        this.fan = {
          supported: true,
          kind: 'toggle',
          instance: c.instance,
          modes: [
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
          ],
        };
        break;
      }
    }
    return this.fan;
  }

  async poll() {
    const reqs = [];
    const owner = new Map();
    for (const dev of this.devices.values()) {
      for (const id of [dev.id, ...dev.merged]) {
        reqs.push({ entityId: id, entityType: 'APPLIANCE' });
        owner.set(id, dev.id);
      }
    }
    if (!reqs.length) return {};
    const res = await this.#call('querySmarthomeDevices', reqs, 'APPLIANCE', TIMEOUT_MS);
    this.lastRaw.state = res;
    const now = Date.now();
    const out = {};
    for (const ds of res?.deviceStates || []) {
      const id = owner.get(ds.entity?.entityId);
      if (!id) continue;
      const r = (out[id] ||= { reachable: true, at: now });
      for (const raw of ds.capabilityStates || []) {
        const cap = parseMaybeJson(raw);
        if (!cap || typeof cap !== 'object') continue;
        this.#applyCap(r, cap, this.devices.get(id));
      }
    }
    for (const e of res?.errors || []) {
      const id = owner.get(e.entity?.entityId);
      if (id && !out[id]) out[id] = { reachable: false, at: now, error: e.code };
    }
    return out;
  }

  #applyCap(r, cap, dev) {
    const v = cap.value;
    switch (`${cap.namespace}.${cap.name}`) {
      case 'Alexa.TemperatureSensor.temperature':
        r.temp = round1(toF(v?.value ?? v, v?.scale));
        if (cap.timeOfSample) r.sampledAt = Date.parse(cap.timeOfSample) || undefined;
        break;
      case 'Alexa.ThermostatController.targetSetpoint':
        r.setpoint = toF(v?.value ?? v, v?.scale);
        if (v?.scale) this.scale = String(v.scale).toUpperCase();
        break;
      case 'Alexa.ThermostatController.lowerSetpoint':
        r.lowerSetpoint = toF(v?.value ?? v, v?.scale);
        break;
      case 'Alexa.ThermostatController.upperSetpoint':
        r.upperSetpoint = toF(v?.value ?? v, v?.scale);
        break;
      case 'Alexa.ThermostatController.thermostatMode':
        r.mode = String(v?.value ?? v).toUpperCase();
        break;
      case 'Alexa.EndpointHealth.connectivity':
        r.reachable = (v?.value ?? v) !== 'UNREACHABLE';
        break;
      case 'Alexa.RangeController.rangeValue':
        if (dev?.humidityInstance && cap.instance === dev.humidityInstance) r.humidity = Number(v);
        break;
      case 'Alexa.ModeController.mode':
        if (dev?.id === this.thermostatId && this.fan.kind === 'mode' && cap.instance === this.fan.instance) r.fan = v;
        break;
      case 'Alexa.ToggleController.toggleState':
        if (dev?.id === this.thermostatId && this.fan.kind === 'toggle' && cap.instance === this.fan.instance) {
          r.fan = v === 'ON' ? 'on' : 'auto';
        }
        break;
    }
    if (dev?.id === this.thermostatId) r.fanSupported = this.fan.supported;
  }

  // Commands go out one at a time so they reach the thermostat in order.
  #control(parameters) {
    const run = async () => {
      const dev = this.devices.get(this.thermostatId);
      if (!dev) throw new Error('No thermostat selected');
      const res = await this.#call('executeSmarthomeDeviceAction', dev.entityId, parameters, 'APPLIANCE');
      const r = res?.controlResponses?.[0];
      if (r?.code === 'SUCCESS') return r;
      const e = res?.errors?.[0];
      throw new Error(e ? `${e.code}${e.message ? `: ${e.message}` : ''}` : 'Thermostat rejected the command');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  setMode(mode) {
    return this.#control({ action: 'setThermostatMode', 'thermostatMode.value': mode });
  }

  setSetpoint(f) {
    return this.#control({
      action: 'setTargetTemperature',
      'targetTemperature.value': String(fromF(f, this.scale)),
      'targetTemperature.scale': this.scale,
    });
  }

  setFan(value) {
    if (!this.fan.supported) throw new Error('This thermostat does not expose fan control to Alexa');
    if (this.fan.kind === 'toggle') {
      return this.#control({ action: value === 'on' ? 'turnOnToggle' : 'turnOffToggle', instance: this.fan.instance });
    }
    return this.#control({ action: 'setModeValue', mode: value, instance: this.fan.instance });
  }

  // For the device inspector page: what Amazon actually returned.
  async raw() {
    return {
      devices: [...this.devices.values()].map(({ caps, ...d }) => ({ ...d, capabilities: caps })),
      fan: this.fan,
      lastState: this.lastRaw.state,
    };
  }
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
