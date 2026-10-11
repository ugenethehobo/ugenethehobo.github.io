// Weekly schedule math. Entries are "at this time on these days, switch to
// this program". The active entry is the most recent one that has started;
// a manual override lasts until the next entry starts.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// All occurrences of an entry between `from` and `to` (Date objects, local time).
function occurrences(entry, from, to) {
  const out = [];
  const { h, m } = parseTime(entry.time);
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  for (let d = new Date(start); d <= to; d.setDate(d.getDate() + 1)) {
    if (!entry.days.includes(d.getDay())) continue;
    const at = new Date(d);
    at.setHours(h, m, 0, 0);
    if (at >= from && at <= to) out.push(at.getTime());
  }
  return out;
}

export function activeEntry(entries, now = new Date()) {
  let best = null;
  const from = new Date(now.getTime() - 8 * DAY_MS);
  for (const entry of entries || []) {
    if (!entry.days?.length) continue;
    for (const at of occurrences(entry, from, now)) {
      if (!best || at > best.at) best = { entry, at };
    }
  }
  return best;
}

export function nextChange(entries, now = new Date()) {
  let best = null;
  const from = new Date(now.getTime() + 1000);
  const to = new Date(now.getTime() + 8 * DAY_MS);
  for (const entry of entries || []) {
    if (!entry.days?.length) continue;
    for (const at of occurrences(entry, from, to)) {
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

// What the house should be doing right now, and why.
export function effectiveProgram(store, now = new Date()) {
  const { base, schedule, override } = store;
  let program = { ...base };
  let source = 'manual';
  let entry = null;
  if (schedule.enabled && schedule.entries.length) {
    const active = activeEntry(schedule.entries, now);
    if (active) {
      program = { ...program, ...pickProgram(active.entry) };
      entry = active.entry;
      source = 'schedule';
    }
  }
  const overrideActive = override && (!override.until || override.until > now.getTime());
  if (overrideActive) {
    program = { ...program, ...pickProgram(override) };
    source = 'hold';
  }
  const next = schedule.enabled ? nextChange(schedule.entries, now) : null;
  return {
    program,
    source,
    entry,
    override: overrideActive ? override : null,
    next: next ? { at: next.at, entry: next.entry } : null,
  };
}
