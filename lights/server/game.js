// Reads ESPN's public NFL data (the same feed espn.com uses) and turns each
// new play into a game event for the lights: touchdown, field goal,
// takeaway, sack, flag, kickoff, and so on.

import { EVENTS } from './effects.js';

export const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

const teamInfo = (c) => ({
  id: String(c.team?.id ?? c.id),
  abbr: c.team?.abbreviation || '',
  name: c.team?.shortDisplayName || c.team?.name || c.team?.displayName || '',
  color: c.team?.color ? '#' + c.team.color : null,
  alt: c.team?.alternateColor ? '#' + c.team.alternateColor : null,
});

// This week's game for a team from the scoreboard, or null (bye week).
export function findGame(scoreboard, teamId) {
  for (const e of scoreboard?.events || []) {
    const c = e.competitions?.[0];
    const us = c?.competitors?.find((x) => String(x.team?.id ?? x.id) === String(teamId));
    if (!us) continue;
    const them = c.competitors.find((x) => x !== us);
    return {
      id: String(e.id),
      start: Date.parse(c.date || e.date),
      state: c.status?.type?.state || e.status?.type?.state || 'pre',
      detail: c.status?.type?.shortDetail || c.status?.type?.detail || '',
      home: us.homeAway === 'home',
      us: teamInfo(us),
      opp: teamInfo(them),
      name: e.shortName || e.name || '',
    };
  }
  return null;
}

// Score, status and every play so far, in order, from a game summary.
export function parseSummary(summary) {
  const comp = summary?.header?.competitions?.[0] || {};
  const st = comp.status || {};
  const byId = new Map();
  const drives = [...(summary?.drives?.previous || [])];
  if (summary?.drives?.current) drives.push(summary.drives.current);
  for (const d of drives) for (const p of d.plays || []) if (p?.id != null) byId.set(String(p.id), p);
  const plays = [...byId.values()].sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
  const scores = {};
  for (const c of comp.competitors || []) scores[String(c.team?.id ?? c.id)] = Number(c.score) || 0;
  return {
    state: st.type?.state || 'pre',
    completed: !!st.type?.completed,
    detail: st.type?.shortDetail || st.type?.detail || '',
    period: st.period || 0,
    clock: st.displayClock || '',
    scores,
    plays,
  };
}

// Highest first: one play shows one effect.
const PRIORITY = ['td', 'takeaway', 'fg', 'safety', 'oppTd', 'giveaway', 'oppFg', 'sack', 'flag', 'bigPlay', 'kickoff'];

// What a play means for our team. `prev` is { home, away } before the play.
export function classifyPlay(play, { teamId, home, prev }) {
  const us = String(teamId);
  const text = String(play.text || '');
  const typeId = String(play.type?.id || '');
  const typeText = String(play.type?.text || '');
  const offenseId = play.teamParticipants?.find((t) => t.type === 'offense')?.id ?? play.start?.team?.id;
  const offense = offenseId != null ? String(offenseId) : null;
  const noPlay = /\bNo Play\b/i.test(text); // wiped out by a penalty
  const events = [];
  const after = {
    home: Number.isFinite(+play.homeScore) ? +play.homeScore : prev.home,
    away: Number.isFinite(+play.awayScore) ? +play.awayScore : prev.away,
  };
  const ours = home ? after.home - prev.home : after.away - prev.away;
  const theirs = home ? after.away - prev.away : after.home - prev.home;

  if (ours >= 6) events.push('td');
  else if (ours === 3) events.push('fg');
  else if (ours === 2) events.push('safety');
  if (theirs >= 6) events.push('oppTd');
  else if (theirs >= 2) events.push('oppFg');

  if (play.isTurnover) events.push(offense === us ? 'giveaway' : 'takeaway');
  if (!noPlay && (typeId === '7' || /\bsacked\b/i.test(text)) && offense && offense !== us) events.push('sack');
  if (play.isPenalty || /\bPENALTY on\b/i.test(text)) events.push('flag');
  if (typeId === '53' || /kickoff/i.test(typeText) || /\bkicks (onside )?\d+ yards from\b/i.test(text)) events.push('kickoff');
  if (!noPlay && offense === us && Number(play.statYardage) >= 25 && !play.scoringPlay && ['5', '24'].includes(typeId)) events.push('bigPlay');

  const penaltyOn = text.match(/PENALTY on ([A-Z]{2,3})\b/)?.[1] || null;
  return { events, after, penaltyOn };
}

export function pickEvent(events, enabled) {
  for (const k of PRIORITY) if (events.includes(k) && enabled[k] !== false) return k;
  return null;
}

// A short line for the app's game feed.
export function describe(kind, { penaltyOn, us, opp } = {}) {
  if (kind === 'flag' && penaltyOn) return `Flag on ${penaltyOn}`;
  if (kind === 'oppTd') return `${opp?.abbr || 'Opponent'} touchdown`;
  if (kind === 'oppFg') return `${opp?.abbr || 'Opponent'} score`;
  if (kind === 'win') return `${us?.abbr || 'We'} win!`;
  if (kind === 'loss') return `${us?.abbr || 'We'} lose`;
  return EVENTS[kind]?.label || kind;
}
