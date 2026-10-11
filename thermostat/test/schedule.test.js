import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeEntry, effectiveProgram, nextChange } from '../server/schedule.js';

const weekdays = [1, 2, 3, 4, 5];
const entries = [
  { id: 'wake', time: '06:30', days: weekdays, mode: 'heat', target: 70, sensors: ['t'] },
  { id: 'away', time: '08:30', days: weekdays, mode: 'heat', target: 64, sensors: ['t'] },
  { id: 'night', time: '22:00', days: [0, 1, 2, 3, 4, 5, 6], mode: 'heat', target: 66, sensors: ['bed'] },
];
// Wednesday 2026-10-14
const at = (h, m = 0, day = 14) => new Date(2026, 9, day, h, m);

test('active entry is the most recent one that started', () => {
  assert.equal(activeEntry(entries, at(7)).entry.id, 'wake');
  assert.equal(activeEntry(entries, at(12)).entry.id, 'away');
  assert.equal(activeEntry(entries, at(23)).entry.id, 'night');
  assert.equal(activeEntry(entries, at(3)).entry.id, 'night'); // from last night
});

test('weekend skips weekday entries', () => {
  // Saturday 2026-10-17 at noon: last change was Friday night
  assert.equal(activeEntry(entries, at(12, 0, 17)).entry.id, 'night');
  assert.equal(nextChange(entries, at(12, 0, 17)).entry.id, 'night');
});

test('next change', () => {
  const n = nextChange(entries, at(7));
  assert.equal(n.entry.id, 'away');
  assert.equal(n.at, at(8, 30).getTime());
});

test('a manual hold overrides until the next change, then expires', () => {
  const store = {
    base: { mode: 'off', target: 68, fan: 'auto', sensors: ['t'] },
    schedule: { enabled: true, entries },
    override: { target: 73, until: at(8, 30).getTime() },
  };
  let e = effectiveProgram(store, at(7));
  assert.equal(e.source, 'hold');
  assert.equal(e.program.target, 73);
  assert.equal(e.program.mode, 'heat'); // other fields still from the schedule
  e = effectiveProgram(store, at(9));
  assert.equal(e.source, 'schedule');
  assert.equal(e.program.target, 64);
});

test('schedule off uses manual settings', () => {
  const store = { base: { mode: 'cool', target: 72, sensors: ['t'] }, schedule: { enabled: false, entries }, override: null };
  const e = effectiveProgram(store, at(7));
  assert.equal(e.source, 'manual');
  assert.equal(e.program.target, 72);
  assert.equal(e.next, null);
});
