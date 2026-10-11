// A simulated house for trying the app without an Amazon account
// (`npm run demo`). Rooms drift toward the outdoor temperature, and the
// furnace / A/C push them back when the thermostat calls for it.
import { EventEmitter } from 'node:events';

export class MockDriver extends EventEmitter {
  constructor({ speed = Number(process.env.MOCK_SPEED) || 1 } = {}) {
    super();
    this.speed = speed;
    this.outdoor = 48;
    this.rooms = {
      'mock-thermostat': { name: 'Hallway Thermostat', temp: 68.4, humidity: 41, bias: 0 },
      'mock-aq-living': { name: 'Living Room Air Monitor', temp: 70.2, humidity: 44, bias: 1.2 },
      'mock-aq-bedroom': { name: 'Bedroom Air Monitor', temp: 66.9, humidity: 47, bias: -1.4 },
    };
    this.device = { mode: 'HEAT', setpoint: 69, fan: 'auto' };
    this.running = null;
    this.last = Date.now();
    this.info = { state: 'connected', message: 'Demo mode: simulated thermostat' };
  }

  async connect() {
    return this.info;
  }

  status() {
    return this.info;
  }

  async discover() {
    return {
      thermostats: [{ id: 'mock-thermostat', name: this.rooms['mock-thermostat'].name }],
      sensors: Object.entries(this.rooms).map(([id, r]) => ({
        id,
        name: r.name,
        kind: id === 'mock-thermostat' ? 'thermostat' : 'air-quality',
      })),
      fan: { supported: true, modes: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'circulate', label: 'Circulate' }] },
      modes: ['HEAT', 'COOL', 'AUTO', 'OFF'],
    };
  }

  #tick() {
    const now = Date.now();
    let hours = ((now - this.last) / 3600000) * this.speed;
    this.last = now;
    while (hours > 0) {
      const dt = Math.min(hours, 0.05);
      hours -= dt;
      this.#step(dt);
    }
  }

  #step(hours) {
    const t = this.rooms['mock-thermostat'].temp;
    const { mode, setpoint } = this.device;
    if (this.running === 'heat' && (mode !== 'HEAT' || t >= setpoint + 0.5)) this.running = null;
    if (this.running === 'cool' && (mode !== 'COOL' || t <= setpoint - 0.5)) this.running = null;
    if (!this.running && mode === 'HEAT' && t <= setpoint - 0.5) this.running = 'heat';
    if (!this.running && mode === 'COOL' && t >= setpoint + 0.5) this.running = 'cool';
    for (const room of Object.values(this.rooms)) {
      const drift = (this.outdoor + room.bias - room.temp) * 0.08 * hours;
      const hvac = this.running === 'heat' ? 4 * hours : this.running === 'cool' ? -4 * hours : 0;
      room.temp += drift + hvac;
    }
  }

  useThermostat() {
    return { supported: true, modes: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'circulate', label: 'Circulate' }] };
  }

  async poll() {
    await delay(150);
    this.#tick();
    const out = {};
    for (const [id, r] of Object.entries(this.rooms)) {
      out[id] = { temp: round1(r.temp), humidity: r.humidity, reachable: true, at: Date.now() };
    }
    Object.assign(out['mock-thermostat'], {
      mode: this.device.mode,
      setpoint: this.device.setpoint,
      fan: this.device.fan,
      fanSupported: true,
    });
    return out;
  }

  async setMode(mode) {
    await delay(400);
    this.#tick();
    this.device.mode = mode;
  }

  async setSetpoint(value) {
    await delay(400);
    this.#tick();
    this.device.setpoint = Math.round(value);
  }

  async setFan(value) {
    await delay(400);
    this.#tick();
    this.device.fan = value;
  }

  // Lets the "Link Amazon" screen be tried in demo mode.
  async startLogin() {
    return 'https://www.amazon.com/ap/signin?demo=1';
  }

  async completeLogin(pasted) {
    await delay(600);
    if (!/authorization_code=/.test(String(pasted))) throw new Error('That doesn’t look like the Amazon page address. Copy the whole address after signing in.');
    return this.info;
  }

  async raw() {
    return { demo: true, rooms: this.rooms, device: this.device, running: this.running };
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;
