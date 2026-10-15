// Weekly light schedules. Each entry runs at a clock time, or at sunrise or
// sunset plus an offset, on chosen days, in the household's time zone.

import { DAY_MS, partsIn, sunTimes, zonedTime } from './time.js';

function parseTime(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return { h: Math.min(23, Math.max(0, h || 0)), m: Math.min(59, Math.max(0, m || 0)) };
}

// When an entry would run on a given local date, or null (no location for a
// sun-based entry, or no sunset that day).
export function runTimeOn(entry, tz, loc, y, mo, d) {
  if (entry.sun === 'sunrise' || entry.sun === 'sunset') {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
    const sun = sunTimes(zonedTime(tz, y, mo, d, 12, 0), loc.lat, loc.lon);
    if (!sun) return null;
    return Math.round((sun[entry.sun] + (Number(entry.offset) || 0) * 60000) / 60000) * 60000;
  }
  const { h, m } = parseTime(entry.time);
  return zonedTime(tz, y, mo, d, h, m);
}

// All runs of enabled entries with from < at <= to, oldest first.
export function runsBetween(entries, from, to, tz, loc) {
  const out = [];
  const start = partsIn(tz, from);
  const days = Math.ceil((to - from) / DAY_MS) + 2;
  for (const entry of entries || []) {
    if (!entry.enabled || !entry.days?.length) continue;
    for (let i = -1; i <= days; i++) {
      const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
      if (!entry.days.includes(day.getUTCDay())) continue;
      const at = runTimeOn(entry, tz, loc, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      if (at != null && at > from && at <= to) out.push({ entry, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function nextRun(entries, now, tz, loc) {
  return runsBetween(entries, now, now + 8 * DAY_MS, tz, loc)[0] || null;
}

// Today's sunrise and sunset in the household, for showing in the app.
export function sunToday(now, tz, loc) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  const p = partsIn(tz, now);
  return sunTimes(zonedTime(tz, p.y, p.mo, p.d, 12, 0), loc.lat, loc.lon);
}

const clean = (s, n) => String(s ?? '').trim().slice(0, n);

// Validates one schedule entry from the app.
export function cleanEntry(raw, makeId) {
  const days = [...new Set((raw.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  const sun = raw.sun === 'sunrise' || raw.sun === 'sunset' ? raw.sun : null;
  const a = raw.action || {};
  const power = a.power === 'off' ? 'off' : 'on';
  const t = raw.target || {};
  return {
    id: clean(raw.id, 40) || makeId(),
    name: clean(raw.name, 40) || 'Schedule',
    enabled: raw.enabled !== false,
    days,
    time: sun ? null : `${String(parseTime(raw.time).h).padStart(2, '0')}:${String(parseTime(raw.time).m).padStart(2, '0')}`,
    sun,
    offset: sun ? Math.max(-240, Math.min(240, Math.round(Number(raw.offset) || 0))) : 0,
    target: t.all ? { all: true } : { rooms: (t.rooms || []).map((r) => clean(r, 40)).filter(Boolean), lights: (t.lights || []).map((l) => clean(l, 40)).filter(Boolean) },
    action: {
      power,
      bri: power === 'on' && a.bri != null ? Math.max(1, Math.min(254, Math.round(a.bri))) : null,
      color: power === 'on' && /^#?[0-9a-f]{6}$/i.test(a.color || '') ? ('#' + a.color.replace('#', '')).toLowerCase() : null,
      ct: power === 'on' && a.ct != null && !a.color ? Math.max(153, Math.min(500, Math.round(a.ct))) : null,
      fade: Math.max(0, Math.min(120, Math.round(Number(a.fade) || 0))),
    },
  };
}
