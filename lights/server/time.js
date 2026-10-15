// Wall-clock time in the household's time zone (Cloudflare runs on UTC), and
// sunrise/sunset for the household's location.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();

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

// ---- Sunrise and sunset (after the NOAA / suncalc formulas) ----

const rad = Math.PI / 180;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const e = rad * 23.4397;
const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => (j + 0.5 - J1970) * DAY_MS;

// Sunrise and sunset (ms) on the day containing `ms`, or null in polar day/night.
export function sunTimes(ms, lat, lon) {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(ms);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(e));
  const noon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null;
  const w = Math.acos(cosH);
  const set = J2000 + J0 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  return { sunrise: fromJulian(noon - (set - noon)), sunset: fromJulian(set) };
}

export { DAY_MS };
