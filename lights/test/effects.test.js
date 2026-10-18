import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEffect, effectLength, EVENTS } from '../server/effects.js';

const kinds = Object.keys(EVENTS);

test('every game show lasts at least 5 seconds (the win show longer)', () => {
  for (const k of kinds) {
    const ms = effectLength(buildEffect(k, { bri: 200 }));
    assert.ok(ms >= 5000, `${k}: ${ms} ms`);
    if (k !== 'win' && k !== 'loss') assert.ok(ms <= 11000, `${k}: ${ms} ms`);
  }
  assert.ok(effectLength(buildEffect('win')) >= 20000);
});

test('show length setting stretches and shortens shows', () => {
  const normal = effectLength(buildEffect('td'));
  assert.ok(effectLength(buildEffect('td', { scale: 1.5 })) > normal * 1.4);
  assert.ok(effectLength(buildEffect('td', { scale: 0.6 })) < normal * 0.8); // fast frames can't go below 250 ms
});

test('shows look different even on a single light', () => {
  // What one light does: its colour, brightness and timing, frame by frame.
  const signature = (k) => JSON.stringify(buildEffect(k, { bri: 200 }).map((f) => [f.a.xy || f.a.ct, f.a.bri, f.ms]));
  const seen = new Map();
  for (const k of kinds) {
    const sig = signature(k);
    assert.ok(!seen.has(sig), `${k} looks the same as ${seen.get(sig)}`);
    seen.set(sig, k);
  }
});

test('no frame is too fast for a Hue light to show', () => {
  for (const k of kinds) for (const f of buildEffect(k, { scale: 0.6 })) assert.ok(f.ms >= 250, `${k}: ${f.ms} ms frame`);
});
