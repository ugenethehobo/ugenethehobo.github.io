import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Home } from '../server/home.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/kc-game.json', import.meta.url)));
const MIN = 60_000;

// A house with one fake hub and a controllable clock.
function setup({ now = Date.parse('2026-10-18T12:00:00Z'), espn = {} } = {}) {
  const clock = { now };
  const sent = [];
  const saved = {};
  let online = ['hub-a'];
  const home = new Home({
    now: () => clock.now,
    persist: (k, v) => (saved[k] = structuredClone(v)),
    fetchJson: async (url) => {
      const key = url.includes('scoreboard') ? 'scoreboard' : 'summary';
      if (!espn[key]) throw new Error('offline');
      return typeof espn[key] === 'function' ? espn[key]() : espn[key];
    },
    hubs: {
      send: (id, msg) => (online.includes(id) ? (sent.push({ id, ...msg }), true) : false),
      online: () => online,
      close: () => {},
    },
  });
  assert.equal(home.hubConnect('hub-a', '', '1.0'), 'pending');
  home.approveHub('hub-a', 'Sam');
  const token = sent.find((m) => m.t === 'welcome').token;
  assert.equal(home.hubConnect('hub-a', token, '1.0'), 'ok');
  home.onHubMessage('hub-a', {
    t: 'hello',
    fw: '1.0',
    lights: [
      { id: 'AA:BB:CC:00:00:01', name: 'Lamp', caps: { xy: true, ct: true }, connected: true, on: true, bri: 100, ct: 366, mode: 'ct' },
      { id: 'aa:bb:cc:00:00:02', name: 'Ceiling', caps: { xy: true, ct: true }, connected: true, on: false, bri: 254, xy: [0.3, 0.3], mode: 'xy' },
    ],
  });
  sent.length = 0;
  return { home, clock, sent, saved, setOnline: (o) => (online = o) };
}

test('a new hub has to be approved, then its lights appear', () => {
  const { home, saved } = setup();
  const s = home.snapshot();
  assert.equal(s.hubs.length, 1);
  assert.equal(s.hubs[0].online, true);
  assert.deepEqual(s.lights.map((l) => l.name), ['Ceiling', 'Lamp']);
  assert.ok(s.lights.every((l) => l.reachable));
  assert.equal(saved.config.lights['aa:bb:cc:00:00:01'].bri, 100);
  // A stranger with a wrong token waits for approval.
  assert.equal(home.hubConnect('hub-a', 'nope', '1.0'), 'pending');
  assert.equal(home.hubConnect('hub-b', '', '1.0'), 'pending');
  assert.equal(home.snapshot().hubs.filter((h) => h.pending).length, 2);
});

test('controlling a room sends one message per hub and remembers the state', () => {
  const { home, sent } = setup();
  home.updateLight({ id: 'aa:bb:cc:00:00:01', room: 'Living room' }, 'Sam');
  home.updateLight({ id: 'aa:bb:cc:00:00:02', room: 'Living room' }, 'Sam');
  home.control({ target: { room: 'Living room' }, color: '#ff0000', bri: 200 }, 'Sam');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'set');
  assert.deepEqual(sent[0].ids.sort(), ['aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02']);
  assert.equal(sent[0].s.on, true);
  assert.equal(sent[0].s.bri, 200);
  assert.ok(sent[0].s.xy[0] > 0.6);
  const lamp = home.snapshot().lights.find((l) => l.name === 'Lamp');
  assert.equal(lamp.mode, 'xy');
  assert.equal(lamp.hex, '#ff0000');
  assert.deepEqual(home.snapshot().rooms, ['Living room']);
});

test('an offline hub is reported instead of failing silently', () => {
  const { home, setOnline } = setup();
  setOnline([]);
  const r = home.control({ target: { all: true }, on: false }, 'Sam');
  assert.deepEqual(r.offline.sort(), ['Ceiling', 'Lamp']);
  assert.ok(home.snapshot().lights.every((l) => !l.reachable));
});

test('scanning and pairing a light', () => {
  const { home, sent } = setup();
  home.startScan({}, 'Sam');
  assert.deepEqual(sent.pop(), { id: 'hub-a', t: 'scan', sec: 30, all: false });
  home.onHubMessage('hub-a', { t: 'found', id: 'aa:bb:cc:00:00:03', name: 'Hue color lamp', rssi: -60, addrType: 1 });
  assert.equal(home.snapshot().scan.found.length, 1);
  home.pair({ id: 'aa:bb:cc:00:00:03', name: 'Desk', room: 'Office' }, 'Sam');
  assert.deepEqual(sent.pop(), { id: 'hub-a', t: 'pair', id: 'aa:bb:cc:00:00:03', addrType: 1 });
  home.onHubMessage('hub-a', { t: 'paired', id: 'aa:bb:cc:00:00:03', ok: true, name: 'Hue color lamp', model: 'LCA001', caps: { xy: true, ct: true }, on: true, bri: 254, ct: 300, mode: 'ct' });
  const desk = home.snapshot().lights.find((l) => l.id === 'aa:bb:cc:00:00:03');
  assert.equal(desk.name, 'Desk');
  assert.equal(desk.room, 'Office');
  assert.deepEqual(sent.pop(), { id: 'hub-a', t: 'rename', id: 'aa:bb:cc:00:00:03', name: 'Desk' });
  assert.equal(home.snapshot().scan.found[0].status, 'paired');
});

test('a schedule runs once at its time, with a fade', async () => {
  const start = Date.parse('2026-10-19T11:55:00Z'); // 6:55 CDT, a Monday
  const { home, clock, sent } = setup({ now: start });
  home.setSchedules([{ name: 'Wake up', days: [1, 2, 3, 4, 5], time: '07:00', target: { all: true }, action: { power: 'on', bri: 254, ct: 250, fade: 20 } }], 'Sam');
  home.config.chiefs.enabled = false;
  assert.equal(home.nextWake(), Date.parse('2026-10-19T12:00:00Z'));
  clock.now = Date.parse('2026-10-19T12:00:00Z');
  await home.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ms, 20 * MIN);
  assert.deepEqual(sent[0].s, { on: true, bri: 254, ct: 250 });
  clock.now += 30_000;
  await home.tick();
  assert.equal(sent.length, 1, 'does not run twice');
  assert.equal(home.nextWake(), Date.parse('2026-10-20T12:00:00Z'));
});

test('sunset schedules need a location and follow the sun', () => {
  const { home } = setup({ now: Date.parse('2026-10-18T12:00:00Z') });
  home.config.chiefs.enabled = false;
  home.setSchedules([{ name: 'Evening', days: [0, 1, 2, 3, 4, 5, 6], sun: 'sunset', offset: -15, target: { all: true }, action: { power: 'on', bri: 180 } }], 'Sam');
  assert.equal(home.snapshot().nextSchedule, null);
  home.setSettings({ lat: 39.1, lon: -94.58 }, 'Sam'); // Kansas City
  const next = home.snapshot().nextSchedule;
  const local = new Date(next.at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  assert.match(local, /^6:(1|2|3)\d PM$/, local); // KC sunset mid-October is about 6:35 PM
});

// Builds ESPN-like replies from the recorded game, as if it were in progress.
function liveGame(upTo) {
  const plays = fx.plays.slice(0, upTo);
  const last = plays[plays.length - 1] || { homeScore: 0, awayScore: 0 };
  const done = upTo >= fx.plays.length;
  return {
    header: {
      competitions: [
        {
          status: { type: { state: upTo === 0 ? 'pre' : done ? 'post' : 'in', completed: done, shortDetail: done ? 'Final' : 'In progress' }, period: 1, displayClock: '10:00' },
          competitors: [
            { id: fx.home.id, score: String(last.homeScore) },
            { id: fx.away.id, score: String(last.awayScore) },
          ],
        },
      ],
    },
    drives: { previous: [{ plays }] },
  };
}

const kickoff = Date.parse('2026-10-04T20:25:00Z');
const scoreboard = {
  events: [
    {
      id: fx.event,
      shortName: 'KC @ LV',
      competitions: [
        {
          date: '2026-10-04T20:25Z',
          status: { type: { state: 'pre', shortDetail: '10/4 - 3:25 PM CDT' } },
          competitors: [
            { homeAway: 'home', team: { id: '13', abbreviation: 'LV', color: '000000' } },
            { homeAway: 'away', team: { id: '12', abbreviation: 'KC', color: 'e31837', alternateColor: 'ffb612' } },
          ],
        },
      ],
    },
  ],
};

test('game day: red before kickoff, effects for plays, back to normal after', async () => {
  let upTo = 0;
  const { home, clock, sent } = setup({ now: kickoff - 3 * 60 * MIN, espn: { scoreboard, summary: () => liveGame(upTo) } });
  home.setChiefs({ pregameMin: 30, postgameMin: 20, delaySec: 0 }, 'Sam');

  await home.tick();
  assert.equal(home.snapshot().chiefs.phase, 'scheduled');
  assert.equal(home.nextWake(), kickoff - 30 * MIN);
  assert.equal(sent.length, 0);

  // 30 minutes before kickoff, every light goes Chiefs red.
  clock.now = kickoff - 30 * MIN;
  await home.tick();
  const red = sent.find((m) => m.t === 'set');
  assert.ok(red && red.s.on && red.s.xy[0] > 0.6, 'lights turn red');
  assert.ok(home.snapshot().chiefs.active);
  sent.length = 0;

  // Kickoff: following plays.
  clock.now = kickoff;
  await home.tick();
  upTo = 1; // the opening kickoff, which ESPN shows a few seconds after it happens
  clock.now = Date.parse(fx.plays[0].wallclock) + 5000;
  await home.tick();
  let shows = sent.filter((m) => m.t === 'fx');
  assert.equal(shows.length, 1, 'kickoff effect');

  // Fast-forward to just after the first Chiefs touchdown.
  const kcTd = fx.plays.findIndex((p) => p.type.text.includes('Touchdown') && p.awayScore === 7);
  upTo = kcTd + 1;
  clock.now = Date.parse(fx.plays[kcTd].wallclock) + 5000;
  await home.tick();
  // Several plays arrived at once: they play one after another, TD included.
  const feed = home.snapshot().chiefs.recent.map((r) => r.kind);
  assert.ok(feed.includes('td'), feed.join());
  assert.ok(feed.includes('oppTd'), feed.join());
  for (let i = 0; i < 40; i++) {
    clock.now += 5000;
    await home.tick();
  }
  assert.equal(home.game.queue.length, 0);

  // Final whistle: a win show, then lights restore 20 minutes later.
  upTo = fx.plays.length;
  clock.now = Date.parse(fx.plays[upTo - 1].wallclock) + 5000;
  sent.length = 0;
  await home.tick();
  clock.now += 1000;
  await home.tick();
  assert.equal(home.snapshot().chiefs.phase, 'final');
  assert.ok(home.snapshot().chiefs.recent.some((r) => r.kind === 'win'));
  assert.ok(sent.some((m) => m.t === 'fx' && m.steps.length > 30), 'win show');
  clock.now += 21 * MIN;
  sent.length = 0;
  await home.tick();
  assert.equal(home.snapshot().chiefs.active, false);
  const back = sent.filter((m) => m.t === 'set');
  const lamp = back.find((m) => m.ids.includes('aa:bb:cc:00:00:01'));
  assert.deepEqual(lamp.s, { on: true, bri: 100, ct: 366 }, 'lamp back to how it was');
  const ceiling = back.find((m) => m.ids.includes('aa:bb:cc:00:00:02'));
  assert.equal(ceiling.s.on, false, 'ceiling back off');

  // The finished game is not picked up again.
  clock.now += 7 * 60 * MIN;
  await home.tick();
  assert.notEqual(home.snapshot().chiefs.phase, 'pregame');
  assert.equal(home.snapshot().chiefs.active, false);
});

test('the TV delay holds effects until the TV shows the play', async () => {
  let upTo = 0;
  const { home, clock, sent } = setup({ now: kickoff - 5 * MIN, espn: { scoreboard, summary: () => liveGame(upTo) } });
  home.setChiefs({ delaySec: 40 }, 'Sam');
  await home.tick();
  sent.length = 0;
  upTo = 1;
  // ESPN shows the opening kickoff 5 s after it happened.
  const wall = Date.parse(fx.plays[0].wallclock);
  clock.now = wall + 5000;
  home.game.nextPoll = 0;
  await home.tick();
  assert.equal(sent.filter((m) => m.t === 'fx').length, 0, 'not yet');
  assert.equal(home.game.queue[0].at, wall + 40_000);
  assert.ok(home.nextWake() <= wall + 40_000);
  clock.now = wall + 40_000;
  await home.tick();
  assert.equal(sent.filter((m) => m.t === 'fx').length, 1, 'now');
});

test('turning Chiefs mode on mid-game does not replay old plays', async () => {
  const { home, clock, sent } = setup({ now: kickoff + 90 * MIN, espn: { scoreboard, summary: () => liveGame(100) } });
  home.setChiefs({ enabled: true }, 'Sam');
  await home.tick();
  assert.equal(sent.filter((m) => m.t === 'fx').length, 0);
  assert.equal(home.snapshot().chiefs.phase, 'live');
  clock.now += 8000;
  await home.tick();
  assert.equal(sent.filter((m) => m.t === 'fx').length, 0);
});

test('test buttons play a show right away', () => {
  const { home, sent } = setup();
  home.testEffect('td', 'Sam');
  const show = sent.find((m) => m.t === 'fx');
  assert.equal(show.ids.length, 2);
  assert.ok(show.steps.some((f) => f.b), 'alternating colours');
});

test('searching for all devices marks which ones look like Hue lights', () => {
  const { home, sent } = setup();
  home.startScan({ all: true }, 'Sam');
  assert.deepEqual(sent.pop(), { id: 'hub-a', t: 'scan', sec: 30, all: true });
  home.onHubMessage('hub-a', { t: 'found', id: 'aa:bb:cc:00:00:09', name: 'Unnamed device', rssi: -70, addrType: 1, hue: false });
  home.onHubMessage('hub-a', { t: 'found', id: 'aa:bb:cc:00:00:09', name: 'Hue play', rssi: -72, addrType: 1, hue: true });
  home.onHubMessage('hub-a', { t: 'log', text: 'Pairing aa:bb:cc:00:00:09: connecting' });
  const s = home.snapshot();
  assert.equal(s.scan.found.length, 1);
  assert.equal(s.scan.found[0].hue, true);
  assert.equal(s.scan.found[0].name, 'Hue play');
  assert.equal(s.hubLog[0].text, 'Pairing aa:bb:cc:00:00:09: connecting');
  home.pair({ id: 'aa:bb:cc:00:00:09' }, 'Sam');
  assert.equal(home.snapshot().scan.running, false, 'the hub stops searching to pair');
});
