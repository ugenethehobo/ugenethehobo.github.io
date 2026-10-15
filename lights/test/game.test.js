import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyPlay, findGame, parseSummary, pickEvent } from '../server/game.js';
import { DEFAULT_EVENTS } from '../server/effects.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/kc-game.json', import.meta.url)));

// A recorded game: KC 30 at LV 27 (Oct 4, 2026).
function replay() {
  const home = fx.home.id === '12';
  let prev = { home: 0, away: 0 };
  const counts = {};
  for (const play of fx.plays) {
    const r = classifyPlay(play, { teamId: '12', home, prev });
    prev = r.after;
    const kind = pickEvent(r.events, DEFAULT_EVENTS);
    if (kind) counts[kind] = (counts[kind] || 0) + 1;
  }
  return { counts, prev };
}

test('a recorded Chiefs game produces the right light events', () => {
  const { counts, prev } = replay();
  assert.equal(counts.td, 4);
  assert.equal(counts.fg, 1);
  assert.equal(counts.oppTd, 2);
  assert.equal(counts.oppFg, 4);
  assert.equal(counts.takeaway, 1);
  assert.equal(counts.kickoff, 12);
  assert.ok(counts.flag >= 12, `flags: ${counts.flag}`);
  assert.equal(counts.sack, undefined, 'both sacks were of our QB, not by our defense');
  assert.deepEqual(prev, { home: 27, away: 30 });
});

test('flags name the team that was penalized', () => {
  const play = fx.plays.find((p) => /PENALTY on LV/.test(p.text));
  const r = classifyPlay(play, { teamId: '12', home: false, prev: { home: play.homeScore, away: play.awayScore } });
  assert.ok(r.events.includes('flag'));
  assert.equal(r.penaltyOn, 'LV');
});

test('a sack by our defense counts', () => {
  const r = classifyPlay(
    { type: { id: '7', text: 'Sack' }, text: 'J.Herbert sacked at LAC 30 for -6 yards (C.Jones).', start: { team: { id: '24' } }, homeScore: 0, awayScore: 0 },
    { teamId: '12', home: true, prev: { home: 0, away: 0 } },
  );
  assert.equal(pickEvent(r.events, DEFAULT_EVENTS), 'sack');
});

test('a pick-six is a touchdown, not just a takeaway', () => {
  const r = classifyPlay(
    { type: { id: '36', text: 'Interception Return Touchdown' }, text: '… INTERCEPTED … TOUCHDOWN.', isTurnover: true, scoringPlay: true, start: { team: { id: '24' } }, homeScore: 7, awayScore: 0 },
    { teamId: '12', home: true, prev: { home: 0, away: 0 } },
  );
  assert.deepEqual(r.events.slice(0, 2), ['td', 'takeaway']);
  assert.equal(pickEvent(r.events, DEFAULT_EVENTS), 'td');
});

test('turned-off events are skipped in favour of the next one', () => {
  assert.equal(pickEvent(['flag', 'kickoff'], { ...DEFAULT_EVENTS, flag: false }), 'kickoff');
  assert.equal(pickEvent(['flag'], { ...DEFAULT_EVENTS, flag: false }), null);
});

test('summaries are flattened and de-duplicated across the current drive', () => {
  const plays = fx.plays.slice(0, 6);
  const s = parseSummary({
    header: { competitions: [{ status: { type: { state: 'in', shortDetail: '1st 10:00' }, period: 1, displayClock: '10:00' }, competitors: [{ id: '13', score: '0' }, { id: '12', score: '0' }] }] },
    drives: { previous: [{ plays: plays.slice(0, 4) }], current: { plays: plays.slice(2) } },
  });
  assert.equal(s.state, 'in');
  assert.deepEqual(s.plays.map((p) => p.id), plays.map((p) => p.id));
  assert.deepEqual(s.scores, { 13: 0, 12: 0 });
});

test('finds our game on the scoreboard', () => {
  const g = findGame(
    {
      events: [
        { id: '1', shortName: 'SEA @ DEN', competitions: [{ date: '2026-10-16T00:15Z', status: { type: { state: 'pre' } }, competitors: [{ homeAway: 'home', team: { id: '7' } }, { homeAway: 'away', team: { id: '26' } }] }] },
        { id: '401873006', shortName: 'LAC @ KC', competitions: [{ date: '2026-10-18T20:25Z', status: { type: { state: 'pre', shortDetail: '10/18 - 4:25 PM EDT' } }, competitors: [{ homeAway: 'home', team: { id: '12', abbreviation: 'KC', color: 'e31837', alternateColor: 'ffb612' } }, { homeAway: 'away', team: { id: '24', abbreviation: 'LAC', color: '0080c6' } }] }] },
      ],
    },
    '12',
  );
  assert.equal(g.id, '401873006');
  assert.equal(g.home, true);
  assert.equal(g.opp.abbr, 'LAC');
  assert.equal(g.opp.color, '#0080c6');
  assert.equal(g.start, Date.parse('2026-10-18T20:25Z'));
  assert.equal(findGame({ events: [] }, '12'), null);
});
