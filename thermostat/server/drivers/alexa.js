// Talks to Amazon's (private, undocumented) Alexa smart home API, the same
// endpoints the Alexa app uses. Uses only fetch + Web Crypto, so it runs both
// on Cloudflare Workers and on Node 20+.
//
// Sign-in follows the flow worked out by the community alexa-cookie2 /
// alexa-remote2 projects (MIT), minus their local proxy: the person signs in
// on Amazon's own page, then pastes the address of the page Amazon lands on.
// That address carries a one-time code which we trade for a long-lived
// device registration (refresh token), then for Alexa web cookies.
//
//   discover: POST /nexus/v1/graphql           (device list + capabilities)
//   poll:     POST /api/phoenix/state          (current readings)
//   control:  PUT  /api/phoenix/state          (set mode / set point / fan)
import { EventEmitter } from 'node:events';

const TIMEOUT_MS = 15000;
const SNAPSHOT_VERSION = 2; // bump when saved device info changes shape or meaning
const COOKIE_REFRESH_MS = 24 * 3600 * 1000;
const APP_VERSION = '2.2.651540.0';
const API_USER_AGENT = 'AmazonWebView/Amazon Alexa/2.2.651540.0/iOS/18.3.1/iPhone';
const WEB_USER_AGENT = 'AppleWebKit PitanguiBridge/2.2.595606.0-[HARDWARE=iPhone14_7][SOFTWARE=17.4.1][DEVICE=iPhone]';
const APP_NAME = 'Home Climate';
const CSRF_PATHS = ['/api/language', '/spa/index.html', '/api/devices-v2/device?cached=false', '/api/strings'];

const ENDPOINTS_QUERY = `query Endpoints {
  endpoints {
    items {
      endpointId
      friendlyName
      displayCategories { primary { value } }
      legacyAppliance { applianceId applianceTypes friendlyName entityId mergedApplianceIds capabilities }
    }
  }
}`;

// ---------- small helpers ----------

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function parseCookies(str) {
  const out = {};
  for (const part of String(str || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const cookieString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function mergeSetCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m && m[2] !== '""') jar[m[1].trim()] = m[2];
  }
  return jar;
}

const toF = (v, scale) => {
  if (typeof v !== 'number') v = Number(v);
  if (!Number.isFinite(v)) return null;
  const s = String(scale || 'FAHRENHEIT').toUpperCase();
  if (s.startsWith('C')) return v * 1.8 + 32;
  if (s.startsWith('K')) return (v - 273.15) * 1.8 + 32;
  return v;
};
const fromF = (f, scale) => (String(scale).toUpperCase().startsWith('C') ? Math.round(((f - 32) / 1.8) * 2) / 2 : Math.round(f));
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function friendlyNames(cap) {
  const res = cap.resources || cap.capabilityResources || {};
  return (res.friendlyNames || []).map((n) => n.value?.text || n.value?.assetId || n.friendlyName || '').join(' ');
}

const titleCase = (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

// Amazon often reports fan modes by internal value ("1", "2", "3") with the
// human name in the mode's friendly names: plain text and/or an asset id such
// as "Alexa.Setting.Auto".
export function fanModeLabel(mode) {
  const names = (mode.modeResources || mode.resources || {}).friendlyNames || [];
  const texts = names.map((n) => n.value?.text).filter(Boolean);
  const text = names.find((n) => /^en/i.test(n.value?.locale || '') && n.value?.text)?.value.text || texts[0];
  if (text) return text.replace(/^fan\s+/i, '').replace(/^\w/, (c) => c.toUpperCase());
  const asset = names.map((n) => n.value?.assetId).find(Boolean);
  if (asset) return titleCase(asset.split('.').pop());
  const tail = String(mode.value).split('.').pop();
  return /^\d+$/.test(tail) ? `Mode ${tail}` : titleCase(tail);
}

// Pull the one-time code out of whatever the person pasted.
export function extractAuthCode(pasted) {
  const text = String(pasted || '').trim();
  const m = text.match(/openid\.oa2\.authorization_code=([^&\s#]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  return null;
}

export class AlexaDriver extends EventEmitter {
  // `saved` is whatever `save()` last received; persist it somewhere private.
  constructor({ saved = null, save = () => {}, amazonPage = 'amazon.com', language = 'en-US', logger = console } = {}) {
    super();
    this.data = saved || {};
    this.persist = save;
    this.page = this.data.amazonPage || amazonPage;
    this.language = language;
    this.log = logger;
    this.info = { state: 'connecting', message: 'Connecting to Amazon…' };
    this.devices = new Map();
    this.thermostatId = null;
    this.fan = { supported: false, modes: [] };
    this.scale = 'FAHRENHEIT';
    this.queue = Promise.resolve();
    this.lastRaw = {};
    this.refreshing = null;
  }

  status() {
    return this.info;
  }

  #setInfo(info) {
    this.info = info;
    this.emit('status', info);
  }

  #save() {
    this.persist(structuredClone(this.data));
  }

  async connect() {
    if (this.data.refreshToken && this.data.cookie) {
      this.#setInfo({ state: 'connected', message: 'Connected to Amazon' });
    } else {
      this.#setInfo({ state: 'needs-login', message: 'Link your Amazon account to control the thermostat.' });
    }
    return this.info;
  }

  // ---------- sign-in ----------

  async startLogin() {
    // Same identifiers the Alexa iOS app uses for a new device registration.
    const deviceId = hex(new TextEncoder().encode(hex(randomBytes(16)).toUpperCase())) + '23413249564c5635564d32573831';
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(await sha256(verifier));
    this.data.pending = { deviceId, verifier, at: Date.now() };
    this.#save();
    const p = this.page;
    const handle = p === 'amazon.com' ? '' : `_${p.split('.').pop()}`;
    const params = new URLSearchParams({
      'openid.return_to': `https://www.${p}/ap/maplanding`,
      'openid.assoc_handle': `amzn_dp_project_dee_ios${handle}`,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      pageId: `amzn_dp_project_dee_ios${handle}`,
      accountStatusPolicy: 'P1',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.mode': 'checkid_setup',
      'openid.ns.oa2': `http://www.${p}/ap/ext/oauth/2`,
      'openid.oa2.client_id': `device:${deviceId}`,
      'openid.ns.pape': 'http://specs.openid.net/extensions/pape/1.0',
      'openid.oa2.response_type': 'code',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.pape.max_auth_age': '0',
      'openid.oa2.scope': 'device_auth_access',
      'openid.oa2.code_challenge_method': 'S256',
      'openid.oa2.code_challenge': challenge,
      language: this.language.replace('-', '_'),
    });
    return `https://www.${p}/ap/signin?${params}`;
  }

  async completeLogin(pasted) {
    const code = extractAuthCode(pasted);
    if (!code) throw new Error('That doesn’t look like the Amazon page address. Copy the whole address after signing in.');
    const pending = this.data.pending;
    if (!pending) throw new Error('Start the sign-in again, then paste the new address.');
    const p = this.page;

    // 1. Register as a device (like the Alexa app on a new phone).
    const frc = btoa(String.fromCharCode(...randomBytes(313)));
    const reg = await this.#fetchJson(`https://api.${p}/auth/register`, {
      method: 'POST',
      headers: {
        'User-Agent': API_USER_AGENT,
        'Accept-Language': this.language,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-amzn-identity-auth-domain': `api.${p}`,
      },
      body: JSON.stringify({
        requested_extensions: ['device_info', 'customer_info'],
        cookies: { website_cookies: [], domain: `.${p}` },
        registration_data: {
          domain: 'Device',
          app_version: APP_VERSION,
          device_type: 'A2IVLV5VM2W81',
          device_name: `%FIRST_NAME%'s%DUPE_STRATEGY_1ST%${APP_NAME}`,
          os_version: '18.3.1',
          device_serial: hex(randomBytes(16)),
          device_model: 'iPhone',
          app_name: APP_NAME,
          software_version: '1',
        },
        auth_data: {
          client_id: pending.deviceId,
          authorization_code: code,
          code_verifier: pending.verifier,
          code_algorithm: 'SHA-256',
          client_domain: 'DeviceLegacy',
        },
        user_context_map: { frc },
        requested_token_type: ['bearer', 'mac_dms', 'website_cookies'],
      }),
    });
    const tokens = reg.body?.response?.success?.tokens;
    if (!tokens?.bearer?.refresh_token) {
      const why = reg.body?.response?.error?.message || reg.body?.response?.error?.code;
      throw new Error(`Amazon didn’t accept the sign-in${why ? ` (${why})` : ''}. The code only works once and expires after a few minutes, so sign in again.`);
    }
    this.data = {
      amazonPage: p,
      refreshToken: tokens.bearer.refresh_token,
      deviceId: pending.deviceId,
      linkedAt: Date.now(),
    };
    // 2. Trade the refresh token for Alexa web cookies + CSRF token.
    await this.#refreshCookies();
    this.#setInfo({ state: 'connected', message: 'Connected to Amazon' });
    this.emit('reconnected');
    return this.info;
  }

  async unlink() {
    this.data = {};
    this.#save();
    this.devices.clear();
    this.#setInfo({ state: 'needs-login', message: 'Link your Amazon account to control the thermostat.' });
  }

  async #fetchJson(url, init) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { res, body, text };
  }

  async #refreshCookies() {
    const p = this.page;
    const { res, body } = await this.#fetchJson(`https://www.${p}/ap/exchangetoken/cookies`, {
      method: 'POST',
      headers: {
        'User-Agent': API_USER_AGENT,
        'Accept-Language': this.language,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        'x-amzn-identity-auth-domain': `api.${p}`,
      },
      body: new URLSearchParams({
        'di.os.name': 'iOS',
        app_version: APP_VERSION,
        domain: `.${p}`,
        source_token: this.data.refreshToken,
        requested_token_type: 'auth_cookies',
        source_token_type: 'refresh_token',
        'di.hw.version': 'iPhone',
        'di.sdk.version': '6.12.4',
        app_name: APP_NAME,
        'di.os.version': '16.6',
      }),
    });
    const list = body?.response?.tokens?.cookies?.[`.${p}`];
    if (!list) {
      const err = new Error(`Amazon sign-in expired (${res.status}). Link your Amazon account again.`);
      err.auth = true;
      throw err;
    }
    const jar = mergeSetCookies({}, res);
    for (const c of list) jar[c.Name] = c.Value;

    // The Alexa site hands out its CSRF token as a cookie on first visit.
    for (const path of CSRF_PATHS) {
      if (jar.csrf) break;
      try {
        const r = await fetch(`https://alexa.${p}${path}`, {
          headers: {
            'User-Agent': WEB_USER_AGENT,
            Referer: `https://alexa.${p}/spa/index.html`,
            Origin: `https://alexa.${p}`,
            Cookie: cookieString(jar),
            Accept: '*/*',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        mergeSetCookies(jar, r);
        await r.body?.cancel();
      } catch {
        // try the next one
      }
    }
    if (!jar.csrf) throw new Error('Couldn’t get a session from Amazon. Try again in a minute.');
    this.data.cookie = cookieString(jar);
    this.data.cookieAt = Date.now();
    if (!this.data.apiHost) {
      try {
        const ep = await this.#api('/api/endpoints', { host: `alexa.${p}`, noRefresh: true });
        if (ep?.websiteApiUrl) this.data.apiHost = ep.websiteApiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      } catch {
        // fall back to alexa.<page>
      }
    }
    this.#save();
  }

  #ensureFresh() {
    if (!this.data.refreshToken) return Promise.resolve();
    if (this.data.cookie && Date.now() - (this.data.cookieAt || 0) < COOKIE_REFRESH_MS) return Promise.resolve();
    this.refreshing ||= this.#refreshCookies().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async #api(path, { method = 'GET', body, host, noRefresh = false, retried = false } = {}) {
    if (!noRefresh) {
      try {
        await this.#ensureFresh();
      } catch (err) {
        if (err.auth) this.#needsLogin(err.message);
        throw err;
      }
    }
    if (!this.data.cookie) {
      this.#needsLogin();
      throw new Error('Amazon account not linked');
    }
    const jar = parseCookies(this.data.cookie);
    const h = host || this.data.apiHost || `alexa.${this.page}`;
    const res = await fetch(`https://${h}${path}`, {
      method,
      headers: {
        'User-Agent': WEB_USER_AGENT,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json; charset=utf-8',
        'Accept-Language': this.language,
        Referer: `https://alexa.${this.page}/spa/index.html`,
        Origin: `https://alexa.${this.page}`,
        csrf: jar.csrf,
        Cookie: this.data.cookie,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      if (!retried && !noRefresh) {
        // Cookies can lapse early; get fresh ones once before giving up.
        this.data.cookieAt = 0;
        return this.#api(path, { method, body, host, retried: true });
      }
      this.#needsLogin('Amazon signed this app out. Link your Amazon account again.');
      throw new Error('Amazon session expired');
    }
    const text = await res.text();
    if (/ThrottlingException|Rate exceeded|Too many requests/i.test(text)) throw new Error('Amazon is rate-limiting requests, retrying soon');
    if (res.status >= 500) throw new Error(`Amazon error ${res.status}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Unexpected reply from Amazon (${res.status})`);
    }
  }

  #needsLogin(message) {
    if (this.info.state === 'needs-login') return;
    this.#setInfo({ state: 'needs-login', message: message || 'Link your Amazon account to control the thermostat.' });
  }

  // ---------- devices ----------

  async discover() {
    const res = await this.#api('/nexus/v1/graphql', { method: 'POST', body: { query: ENDPOINTS_QUERY } });
    const items = res?.data?.endpoints?.items;
    if (!Array.isArray(items)) throw new Error('Amazon returned an unexpected device list');
    this.devices.clear();
    this.lastRaw.discovery = items;
    const thermostats = [];
    const sensors = [];
    for (const item of items) {
      const a = item.legacyAppliance || {};
      const id = a.applianceId || item.endpointId;
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
      sensors.push({ id, name: dev.name, kind: dev.kind });
    }
    return { thermostats, sensors, fan: this.fan };
  }

  // Look for a fan control on the chosen thermostat. Amazon exposes these as
  // generic Mode/Toggle controllers whose name mentions the fan.
  useThermostat(id) {
    this.thermostatId = id;
    const dev = this.devices.get(id);
    this.fan = { supported: false, modes: [] };
    if (!dev) return this.fan;
    for (const c of dev.caps) {
      if (!/fan/i.test(`${c.instance || ''} ${friendlyNames(c)}`)) continue;
      if (c.interfaceName === 'Alexa.ModeController' && c.configuration?.supportedModes?.length) {
        this.fan = {
          supported: true,
          kind: 'mode',
          instance: c.instance,
          modes: c.configuration.supportedModes.map((m) => ({ value: m.value, label: fanModeLabel(m) })),
        };
        break;
      }
      if (c.interfaceName === 'Alexa.ToggleController') {
        this.fan = { supported: true, kind: 'toggle', instance: c.instance, modes: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }] };
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
    const res = await this.#api('/api/phoenix/state', { method: 'POST', body: { stateRequests: reqs } });
    this.lastRaw.state = res;
    const now = Date.now();
    const out = {};
    for (const ds of res?.deviceStates || []) {
      const id = owner.get(ds.entity?.entityId);
      if (!id) continue;
      const r = (out[id] ||= { reachable: true, at: now });
      for (const raw of ds.capabilityStates || []) {
        const cap = parseMaybeJson(raw);
        if (cap && typeof cap === 'object') this.#applyCap(r, cap, this.devices.get(id));
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
        if (r.preciseTemp == null) r.temp = round1(toF(v?.value ?? v, v?.scale));
        break;
      case 'Alexa.TemperatureSensor.preciseTemperature':
        r.preciseTemp = r.temp = round1(toF(v?.value ?? v, v?.scale));
        break;
      // The thermostat can regulate on the sensors chosen in the Alexa app
      // ("Selected temperature sensors"); then mode is EXTERNAL and this is
      // the temperature it is actually using.
      case 'Alexa.ThermostatController.ExternalTemperatureSensor.temperature':
        r.externalTemp = round1(toF(v?.value ?? v, v?.scale));
        break;
      case 'Alexa.ThermostatController.ExternalTemperatureSensor.mode':
        r.sensing = String(v?.value ?? v).toUpperCase();
        break;
      // What the equipment is actually doing right now.
      case 'Alexa.ThermostatController.HVAC.Components.coolerOperation':
        r.cooler = String(v?.value ?? v);
        break;
      case 'Alexa.ThermostatController.HVAC.Components.primaryHeaterOperation':
        r.heater = String(v?.value ?? v);
        break;
      case 'Alexa.ThermostatController.HVAC.Components.fanOperation':
        r.fanRunning = String(v?.value ?? v);
        break;
      case 'Alexa.ThermostatController.Configuration.allowedTemperatureRange': {
        const rng = (x) => (x ? [toF(x.minimum?.value, x.minimum?.scale), toF(x.maximum?.value, x.maximum?.scale)] : null);
        r.allowed = { heat: rng(v?.heating), cool: rng(v?.cooling) };
        break;
      }
      case 'Alexa.ThermostatController.Schedule.scheduleEnabled':
        r.alexaSchedule = v === true || v === 'true';
        break;
      case 'Alexa.HumiditySensor.relativeHumidity':
        r.humidity = Number(v?.value ?? v);
        break;
      case 'Alexa.ThermostatController.targetSetpoint':
        r.setpoint = toF(v?.value ?? v, v?.scale);
        if (v?.scale) this.scale = String(v.scale).toUpperCase();
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
        if (dev?.id === this.thermostatId && this.fan.kind === 'toggle' && cap.instance === this.fan.instance) r.fan = v === 'ON' ? 'on' : 'auto';
        break;
    }
    if (dev?.id === this.thermostatId) r.fanSupported = this.fan.supported;
  }

  // Commands go out one at a time so they reach the thermostat in order.
  #control(parameters) {
    const run = async () => {
      const dev = this.devices.get(this.thermostatId);
      if (!dev) throw new Error('No thermostat selected');
      const res = await this.#api('/api/phoenix/state', {
        method: 'PUT',
        body: { controlRequests: [{ entityId: dev.entityId, entityType: 'APPLIANCE', parameters }] },
      });
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

  // Compact device info so a restart doesn't need to rediscover.
  snapshot() {
    return {
      version: SNAPSHOT_VERSION,
      devices: [...this.devices.values()].map(({ caps, ...d }) => d),
      fan: this.fan,
      thermostatId: this.thermostatId,
      scale: this.scale,
    };
  }

  // Returns false when the saved info is from an older version, so the
  // caller rediscovers devices instead.
  restore(s) {
    if (!s?.devices || s.version !== SNAPSHOT_VERSION) return false;
    this.devices = new Map(s.devices.map((d) => [d.id, { ...d, caps: [] }]));
    this.fan = s.fan || this.fan;
    this.thermostatId = s.thermostatId;
    this.scale = s.scale || this.scale;
  }

  // Reads the thermostat's paired temperature sensors from the endpoint the
  // Alexa app uses (found by watching the app: it PUTs here when you change
  // "Selected temperature sensors"). Read-only; never returns tokens.
  async probe() {
    const out = [];
    const dev = this.devices.get(this.thermostatId);
    const list = await this.#api('/nexus/v1/graphql', { method: 'POST', body: { query: '{ endpoints { items { id legacyAppliance { applianceId } } } }' } }).catch(() => null);
    const endpointId = list?.data?.endpoints?.items?.find((i) => i.legacyAppliance?.applianceId === dev?.id)?.id;
    out.push({ label: 'thermostat-endpoint', data: endpointId || null });
    if (!endpointId) return out;
    const path = `/api/shNetworking/v1/temperatureSensor/pairedTemperatureSensors/${encodeURIComponent(endpointId)}`;
    for (const host of [`na-api-alexa.${this.page}`, this.data.apiHost || `alexa.${this.page}`]) {
      try {
        const jar = parseCookies(this.data.cookie);
        const res = await fetch(`https://${host}${path}`, {
          headers: {
            'User-Agent': WEB_USER_AGENT,
            Accept: 'application/json; charset=utf-8',
            'Accept-Language': this.language,
            Referer: `https://alexa.${this.page}/spa/index.html`,
            Origin: `https://alexa.${this.page}`,
            csrf: jar.csrf,
            Cookie: this.data.cookie,
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        out.push({ label: `GET ${host}`, status: res.status, body: text.slice(0, 4000) });
        if (res.ok) break;
      } catch (err) {
        out.push({ label: `GET ${host}`, error: err.message });
      }
    }
    // Sensor ids, to match against whatever the endpoint returns.
    out.push({ label: 'sensors', data: [...this.devices.values()].map((d) => ({ name: d.name, id: d.id, entityId: d.entityId, kind: d.kind })) });
    return out;
  }

  // For the device inspector page: what Amazon returned (never the tokens).
  async raw() {
    return {
      linkedAt: this.data.linkedAt,
      apiHost: this.data.apiHost,
      devices: [...this.devices.values()].map(({ caps, ...d }) => ({ ...d, capabilities: caps })),
      fan: this.fan,
      lastState: this.lastRaw.state,
    };
  }
}
