import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockDriver } from '../server/drivers/mock.js';
import { Engine } from '../server/engine.js';
import { newStore } from '../server/store.js';

async function engine() {
  const d = new MockDriver();
  const e = new Engine(d, newStore(), { schedule: () => {} });
  await e.start({ pollNow: false });
  await e.poll();
  return { d, e };
}

test('first read of the Alexa sensor choice is adopted without overwriting it', async () => {
  const { d, e } = await engine();
  assert.deepEqual(e.store.base.sensors, ['mock-aq-bedroom']);
  assert.deepEqual(d.selected, ['mock-aq-bedroom']);
  assert.equal(e.commands.filter((c) => c.field === 'sensors').length, 0);
});

test('+1 from a widget nudges the current target', async () => {
  const { e } = await engine();
  const before = e.widgetState().program.target;
  await e.control({ delta: 1 }, 'Widget');
  await e.control({ delta: 1 }, 'Widget');
  assert.equal(e.widgetState().program.target, before + 2);
  await assert.rejects(e.control({ delta: 50 }, 'Widget'));
});

test('widget state is compact and complete', async () => {
  const { e } = await engine();
  const w = e.widgetState();
  assert.equal(typeof w.measured, 'number');
  assert.ok(['heating', 'cooling', 'idle'].includes(w.action));
  assert.equal(w.sensorControl, true);
  assert.deepEqual(w.sensors.filter((s) => s.inUse).map((s) => s.id), ['mock-aq-bedroom']);
  assert.ok(JSON.stringify(w).length < 4000);
});

test('adopting the Alexa sensor choice never overwrites scheduled sensors', async () => {
  const d = new MockDriver();
  const e = new Engine(d, newStore({
    schedule: { enabled: true, entries: [
      { id: 'night', time: '22:00', days: [0, 1, 2, 3, 4, 5, 6], mode: 'heat', target: 66, sensors: ['mock-aq-living'] },
      { id: 'blank', time: '07:00', days: [1], mode: 'heat', target: 70, sensors: [] },
    ] },
  }), { schedule: () => {} });
  await e.start({ pollNow: false });
  await e.poll();
  const by = Object.fromEntries(e.store.schedule.entries.map((x) => [x.id, x.sensors]));
  assert.deepEqual(by.night, ['mock-aq-living']);
  assert.deepEqual(by.blank, ['mock-aq-bedroom']);
});

test('schedule state for the iPhone app', async () => {
  const { e } = await engine();
  const s = e.scheduleState();
  assert.equal(s.sensorControl, true);
  assert.equal(s.sensors.length, 3);
  assert.ok(Array.isArray(s.schedule.entries));
});
