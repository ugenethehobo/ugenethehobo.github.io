import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandsFor, decide, measure } from '../server/controller.js';

const settings = { swing: 0.5, maxOffset: 5, smart: { threshold: 1, changeoverDelayMin: 10 }, staleMinutes: 20 };
const now = 1_000_000_000;
const MIN = 60_000;

function run(program, temps, { runtime = {}, thermostat = {}, t = now } = {}) {
  const readings = Object.fromEntries(Object.entries(temps).map(([id, temp]) => [id, { temp, at: t }]));
  const measured = measure(program, readings, 'th', settings, t);
  const th = { id: 'th', temp: temps.th, mode: 'HEAT', setpoint: 69, ...thermostat };
  return decide({ program, measured, thermostat: th, runtime, settings, now: t });
}

test('averages selected sensors and ignores stale ones', () => {
  const readings = { a: { temp: 70, at: now }, b: { temp: 68, at: now }, c: { temp: 50, at: now - 60 * MIN } };
  const m = measure({ sensors: ['a', 'b', 'c'] }, readings, 'th', settings, now);
  assert.equal(m.temp, 69);
  assert.deepEqual(m.stale, ['c']);
});

test('falls back to the thermostat when chosen sensors are offline', () => {
  const m = measure({ sensors: ['a'] }, { th: { temp: 67, at: now } }, 'th', settings, now);
  assert.equal(m.temp, 67);
  assert.equal(m.fallback, true);
});

test('thermostat-only heat is passed straight through', () => {
  const d = run({ mode: 'heat', target: 70, sensors: ['th'] }, { th: 68 });
  assert.equal(d.driven, false);
  assert.deepEqual(d.want, { mode: 'HEAT', setpoint: 70 });
});

test('heat from a remote sensor nudges the thermostat set point', () => {
  // Bedroom is cold but the hallway thermostat is warm
  const d = run({ mode: 'heat', target: 69, sensors: ['bed'] }, { bed: 67, th: 71 });
  assert.equal(d.action, 'heating');
  assert.equal(d.want.mode, 'HEAT');
  assert.equal(d.want.setpoint, 73); // above the thermostat's own 71 so it runs
  // ...and stops once the bedroom is warm
  const d2 = run({ mode: 'heat', target: 69, sensors: ['bed'] }, { bed: 69.6, th: 72 }, { runtime: d.runtime });
  assert.equal(d2.action, 'idle');
  assert.equal(d2.want.setpoint, 69); // below the thermostat's reading, never below target - 5
});

test('nudges never exceed the safety band', () => {
  const d = run({ mode: 'heat', target: 66, sensors: ['bed'] }, { bed: 60, th: 75 });
  assert.equal(d.want.setpoint, 71);
});

test('smart mode on an air monitor: the example from the brief', () => {
  const program = { mode: 'smart', target: 69, sensors: ['bed'] };
  let d = run(program, { bed: 69.5, th: 70 });
  assert.equal(d.action, 'idle');
  d = run(program, { bed: 70, th: 70 }, { runtime: d.runtime });
  assert.equal(d.action, 'cooling');
  assert.equal(d.want.mode, 'COOL');
  d = run(program, { bed: 69.4, th: 70 }, { runtime: d.runtime });
  assert.equal(d.action, 'cooling'); // keeps cooling down to the set point
  d = run(program, { bed: 69, th: 70 }, { runtime: d.runtime, t: now + 5 * MIN });
  assert.equal(d.action, 'idle');
  assert.equal(d.want.mode, 'COOL'); // stays in cool, set point high, until heat is needed
  // Temperature falls fast: heat waits out the changeover delay
  d = run(program, { bed: 68, th: 70 }, { runtime: d.runtime, t: now + 8 * MIN });
  assert.equal(d.action, 'idle');
  assert.match(d.reason, /Waiting/);
  d = run(program, { bed: 67.9, th: 70 }, { runtime: d.runtime, t: now + 16 * MIN });
  assert.equal(d.action, 'heating');
  assert.equal(d.want.mode, 'HEAT');
});

test('smart mode on the thermostat sensor gives the thermostat the real target', () => {
  const program = { mode: 'smart', target: 62, sensors: ['th'] };
  // Warm house: cool to 62, and the thermostat display says Cool 62
  let d = run(program, { th: 68 });
  assert.deepEqual(d.want, { mode: 'COOL', setpoint: 62 });
  assert.equal(d.action, 'cooling');
  d = run(program, { th: 62 }, { runtime: d.runtime, t: now + 30 * MIN });
  assert.deepEqual(d.want, { mode: 'COOL', setpoint: 62 });
  assert.equal(d.action, 'idle');
  // Only switches to heat once it falls past the range, after the changeover wait
  d = run(program, { th: 61.5 }, { runtime: d.runtime, t: now + 31 * MIN });
  assert.equal(d.want.mode, 'COOL');
  d = run(program, { th: 61 }, { runtime: d.runtime, t: now + 45 * MIN });
  assert.deepEqual(d.want, { mode: 'HEAT', setpoint: 62 });
  // ...and back to cool only after the wait
  d = run(program, { th: 63 }, { runtime: d.runtime, t: now + 50 * MIN });
  assert.equal(d.want.mode, 'HEAT');
  assert.match(d.reason, /Waiting/);
  d = run(program, { th: 63 }, { runtime: d.runtime, t: now + 56 * MIN });
  assert.equal(d.want.mode, 'COOL');
});

test('smart threshold is adjustable', () => {
  const program = { mode: 'smart', target: 69, sensors: ['bed'] };
  assert.equal(run(program, { bed: 70, th: 70 }).action, 'cooling');
  const wide = { ...settings, smart: { threshold: 2, changeoverDelayMin: 0 } };
  const readings = { bed: { temp: 70, at: now }, th: { temp: 70, at: now } };
  const m = measure(program, readings, 'th', wide, now);
  const d2 = decide({ program, measured: m, thermostat: { id: 'th', temp: 70 }, runtime: {}, settings: wide, now });
  assert.equal(d2.action, 'idle');
});

test('off turns the system off', () => {
  const d = run({ mode: 'off', target: 69, sensors: ['th'] }, { th: 60 });
  assert.deepEqual(d.want, { mode: 'OFF', setpoint: null });
});

test('commands are not resent when the thermostat already does the right thing', () => {
  const want = { mode: 'HEAT', setpoint: 73, call: true, bounds: [64, 74] };
  assert.deepEqual(commandsFor(want, { mode: 'HEAT', setpoint: 74, temp: 71.5 }, {}), {});
  assert.deepEqual(commandsFor(want, { mode: 'HEAT', setpoint: 71, temp: 71.5 }, {}), { setpoint: 73 });
  assert.deepEqual(commandsFor(want, { mode: 'COOL', setpoint: 74, temp: 71.5 }, {}), { mode: 'HEAT', setpoint: 73 });
  assert.deepEqual(commandsFor({ mode: 'HEAT', setpoint: 70 }, { mode: 'HEAT', setpoint: 70 }, {}), {});
  assert.deepEqual(
    commandsFor({ mode: 'OFF', setpoint: null }, { mode: 'HEAT', setpoint: 70, fan: 'auto', fanSupported: true }, { fan: 'on' }),
    { mode: 'OFF', fan: 'on' },
  );
});

test('switching from plain heat to smart does not wait out a changeover', () => {
  const heat = run({ mode: 'heat', target: 72, sensors: ['th'] }, { th: 70 });
  assert.equal(heat.action, 'heating');
  const d = run({ mode: 'smart', target: 68, sensors: ['th'] }, { th: 70 }, { runtime: heat.runtime });
  assert.equal(d.action, 'cooling');
});
