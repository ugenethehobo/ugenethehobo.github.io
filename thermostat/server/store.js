const DEFAULTS = {
  settings: {
    unit: 'F',
    timeZone: null,
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

export function newStore(saved) {
  return merge(structuredClone(DEFAULTS), saved || {});
}

