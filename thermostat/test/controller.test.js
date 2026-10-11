import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandsFor, decide, effectiveTemp } from '../server/controller.js';

const settings = { smart: { threshold: 1, changeoverDelayMin: 10 } };
const now = 1_000_000_000;
const MIN = 60_000;

const run = (program, thermostat, { runtime = {}, t = now, s = settings } = {}) =>
  decide({ program, thermostat: { mode: 'COOL', setpoint: 70, ...thermostat }, runtime, settings: s, now: t });

test('uses the temperature the thermostat regulates on', () => {
  // Your probe: own sensor 68, selected sensors 65, mode EXTERNAL
  assert.deepEqual(effectiveTemp({ temp: 68.1, sensing: 'EXTERNAL', externalTemp: 65 }), { temp: 65, source: 'selected' });
  assert.deepEqual(effectiveTemp({ temp: 68.1, sensing: 'INTERNAL', externalTemp: 65 }), { temp: 68.1, source: 'thermostat' });
});

test('the thermostat always gets the real target', () => {
  // Selected sensor 65, thermostat 70, Cool 68: just send Cool 68
  const d = run({ mode: 'cool', target: 68 }, { temp: 70, sensing: 'EXTERNAL', externalTemp: 65, cooler: 'OFF', heater: 'OFF' });
  assert.deepEqual(d.want, { mode: 'COOL', setpoint: 68 });
  assert.equal(d.action, 'idle');
  const h = run({ mode: 'heat', target: 68 }, { temp: 70, sensing: 'EXTERNAL', externalTemp: 65, heater: 'STAGE_1', cooler: 'OFF' });
  assert.deepEqual(h.want, { mode: 'HEAT', setpoint: 68 });
  assert.equal(h.action, 'heating');
  assert.equal(h.inferred, false);
});

test('running status comes from the thermostat when it reports it', () => {
  assert.equal(run({ mode: 'cool', target: 60 }, { temp: 68, cooler: 'STAGE_1', heater: 'OFF' }).action, 'cooling');
  const guess = run({ mode: 'cool', target: 60 }, { temp: 68 });
  assert.equal(guess.action, 'cooling');
  assert.equal(guess.inferred, true);
});

test('targets are kept inside what the thermostat allows', () => {
  const allowed = { heat: [40, 87], cool: [43, 90] };
  assert.equal(run({ mode: 'heat', target: 89 }, { temp: 70, allowed }).want.setpoint, 87);
  assert.equal(run({ mode: 'cool', target: 89 }, { temp: 70, allowed }).want.setpoint, 89);
});

test('smart mode switches between cool and heat with the real target', () => {
  const program = { mode: 'smart', target: 62 };
  const at = (temp) => ({ temp: 80, sensing: 'EXTERNAL', externalTemp: temp });
  let d = run(program, at(68));
  assert.deepEqual(d.want, { mode: 'COOL', setpoint: 62 });
  d = run(program, at(61.5), { runtime: d.runtime, t: now + 30 * MIN });
  assert.equal(d.want.mode, 'COOL'); // inside the range: stay put
  d = run(program, at(61), { runtime: d.runtime, t: now + 45 * MIN });
  assert.deepEqual(d.want, { mode: 'HEAT', setpoint: 62 });
  // Swinging back quickly waits out the changeover delay
  d = run(program, at(63), { runtime: d.runtime, t: now + 50 * MIN });
  assert.equal(d.want.mode, 'HEAT');
  assert.match(d.reason, /Waiting/);
  d = run(program, at(63), { runtime: d.runtime, t: now + 56 * MIN });
  assert.equal(d.want.mode, 'COOL');
});

test('smart range is adjustable', () => {
  const wide = { smart: { threshold: 2, changeoverDelayMin: 0 } };
  const d = run({ mode: 'smart', target: 69 }, { temp: 68, cooler: 'OFF' }, { runtime: { context: 'heat' }, s: wide });
  assert.equal(d.want.mode, 'HEAT');
  const d2 = run({ mode: 'smart', target: 69 }, { temp: 71 }, { runtime: { context: 'heat' }, s: wide });
  assert.equal(d2.want.mode, 'COOL');
});

test('off turns the system off', () => {
  assert.deepEqual(run({ mode: 'off', target: 69 }, { temp: 60 }).want, { mode: 'OFF', setpoint: null });
});

test('commands are only sent when something differs', () => {
  assert.deepEqual(commandsFor({ mode: 'COOL', setpoint: 62 }, { mode: 'COOL', setpoint: 62 }, {}), {});
  assert.deepEqual(commandsFor({ mode: 'COOL', setpoint: 62 }, { mode: 'COOL', setpoint: 67 }, {}), { setpoint: 62 });
  assert.deepEqual(commandsFor({ mode: 'HEAT', setpoint: 62 }, { mode: 'COOL', setpoint: 62 }, {}), { mode: 'HEAT', setpoint: 62 });
  assert.deepEqual(
    commandsFor({ mode: 'OFF', setpoint: null }, { mode: 'HEAT', setpoint: 70, fan: 'auto', fanSupported: true }, { fan: 'on' }),
    { mode: 'OFF', fan: 'on' },
  );
});

test('works out which sensors the thermostat is following', async () => {
  const { inferSelectedSensors } = await import('../server/controller.js');
  // Your readings: external 64°F; monitors 17.75°C and 19.25°C; thermostat 67.1°F
  const sensors = [
    { id: 'aq1', temp: 63.95 },
    { id: 'aq2', temp: 66.65 },
    { id: 'th', temp: 67.09 },
  ];
  assert.deepEqual(inferSelectedSensors(64, sensors), ['aq1']);
  assert.deepEqual(inferSelectedSensors(65, sensors), ['aq1', 'aq2']); // average 65.3
  assert.equal(inferSelectedSensors(67, sensors), null); // aq2+th and th alone both fit
  assert.equal(inferSelectedSensors(undefined, sensors), null);
});
