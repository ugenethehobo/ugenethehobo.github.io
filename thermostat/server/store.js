import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');

const DEFAULTS = {
  settings: {
    unit: 'F',
    thermostatId: null,
    sensorNames: {},
    hiddenSensors: [],
    swing: 0.5,
    maxOffset: 5,
    smart: { threshold: 1, changeoverDelayMin: 10 },
    pollSeconds: 60,
    staleMinutes: 20,
    minTarget: 50,
    maxTarget: 90,
  },
  base: { mode: 'heat', target: 69, fan: 'auto', sensors: [] },
  schedule: { enabled: false, entries: [] },
  override: null,
  runtime: {},
  activity: [],
};

function merge(defaults, value) {
  if (Array.isArray(defaults) || typeof defaults !== 'object' || defaults === null) {
    return value === undefined ? defaults : value;
  }
  const out = { ...defaults };
  for (const k of Object.keys(value || {})) {
    out[k] = k in defaults ? merge(defaults[k], value[k]) : value[k];
  }
  return out;
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadStore() {
  return merge(structuredClone(DEFAULTS), readJson('state.json', {}));
}

let saveTimer = null;
export function saveStore(store, { now = false } = {}) {
  clearTimeout(saveTimer);
  if (now) return writeJson('state.json', store);
  saveTimer = setTimeout(() => writeJson('state.json', store), 250);
}

export function logActivity(store, by, text) {
  store.activity.unshift({ at: Date.now(), by: by || 'System', text });
  store.activity.length = Math.min(store.activity.length, 100);
}
