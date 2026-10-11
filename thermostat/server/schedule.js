// Weekly schedule math. Entries are "at this time on these days, switch to
// this program". The active entry is the most recent one that has started;
// a manual override lasts until the next entry starts.
//
// Times are wall-clock times in the household's time zone (servers such as
// Cloudflare run on UTC), including across daylight-saving changes.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();

export function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      }),
    );
  }
  return fmtCache.get(tz);
}

// Wall-clock parts of an instant in a time zone.
export function partsIn(tz, ms) {
  const p = Object.fromEntries(formatter(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WEEKDAYS[p.weekday] };
}

function offsetAt(tz, ms) {
  const p = partsIn(tz, ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000;
}

// The instant when it's y-mo-d h:mi on the wall clock in `tz`.
export function zonedTime(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let at = guess - offsetAt(tz, guess);
  const again = guess - offsetAt(tz, at);
  if (again !== at) at = again; // crossed a DST change
  return at;
}

function parseTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// All occurrences (ms) of an entry between `from` and `to` (ms).
function occurrences(entry, from, to, tz) {
  const out = [];
  const { h, m } = parseTime(entry.time);
  const start = partsIn(tz, from);
  for (let i = -1; ; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const at = zonedTime(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m);
    if (at > to + DAY_MS) break;
    if (entry.days.includes(day.getUTCDay()) && at >= from && at <= to) out.push(at);
  }
  return out;
}

const ms = (d) => (d instanceof Date ? d.getTime() : d);

export function activeEntry(entries, now = Date.now(), tz = defaultTimeZone()) {
  let best = null;
  const t = ms(now);
  for (const entry of entries || []) {
    if (!entry.days?.length) continue;
    for (const at of occurrences(entry, t - 8 * DAY_MS, t, tz)) {
      if (!best || at > best.at) best = { entry, at };
    }
  }
  return best;
}

export function nextChange(entries, now = Date.now(), tz = defaultTimeZone()) {
  let best = null;
  const t = ms(now);
  for (const entry of entries || []) {
    if (!entry.days?.length) continue;
    for (const at of occurrences(entry, t + 1000, t + 8 * DAY_MS, tz)) {
      if (!best || at < best.at) best = { entry, at };
    }
  }
  return best;
}

const PROGRAM_KEYS = ['mode', 'target', 'fan', 'sensors'];

export function pickProgram(obj) {
  const out = {};
  for (const k of PROGRAM_KEYS) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function storeTimeZone(store) {
  const tz = store.settings?.timeZone;
  return tz && isValidTimeZone(tz) ? tz : defaultTimeZone();
}

// What the house should be doing right now, and why.
export function effectiveProgram(store, now = Date.now()) {
  const { base, schedule, override } = store;
  const tz = storeTimeZone(store);
  const t = ms(now);
  let program = { ...base };
  let source = 'manual';
  let entry = null;
  if (schedule.enabled && schedule.entries.length) {
    const active = activeEntry(schedule.entries, t, tz);
    if (active) {
      program = { ...program, ...pickProgram(active.entry) };
      entry = active.entry;
      source = 'schedule';
    }
  }
  const overrideActive = override && (!override.until || override.until > t);
  if (overrideActive) {
    program = { ...program, ...pickProgram(override) };
    source = 'hold';
  }
  const next = schedule.enabled ? nextChange(schedule.entries, t, tz) : null;
  return {
    program,
    source,
    entry,
    override: overrideActive ? override : null,
    next: next ? { at: next.at, entry: next.entry } : null,
  };
}
