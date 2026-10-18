// Light shows for game events. The hub plays them itself (so timing doesn't
// depend on the internet), then puts each light back to its game colour.
//
// A show is a list of frames. Each frame sets every light to `a`, or, when a
// frame has `b`, alternates: 1st, 3rd, 5th… light get `a`, the others `b`.

import { hexToXy } from './color.js';

export const EVENTS = {
  td: { label: 'Touchdown', who: 'us' },
  fg: { label: 'Field goal', who: 'us' },
  safety: { label: 'Safety / 2 points', who: 'us' },
  takeaway: { label: 'Takeaway (INT / fumble)', who: 'us' },
  sack: { label: 'Sack by our defense', who: 'us' },
  bigPlay: { label: 'Big play (25+ yards)', who: 'us' },
  oppTd: { label: 'Opponent touchdown', who: 'them' },
  oppFg: { label: 'Opponent field goal / score', who: 'them' },
  giveaway: { label: 'We turned it over', who: 'them' },
  flag: { label: 'Flag (penalty)', who: 'any' },
  kickoff: { label: 'Kickoff', who: 'any' },
  win: { label: 'Win', who: 'us' },
  loss: { label: 'Loss', who: 'them' },
};

// Which events are on until changed in the app.
export const DEFAULT_EVENTS = {
  td: true,
  fg: true,
  safety: true,
  takeaway: true,
  sack: true,
  bigPlay: false,
  oppTd: true,
  oppFg: true,
  giveaway: true,
  flag: true,
  kickoff: true,
  win: true,
  loss: true,
};

const WHITE = { ct: 160 };
const YELLOW = { xy: [0.47, 0.475] };

function repeat(n, frames) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(...frames);
  return out;
}

// Each show has its own rhythm, not just its own colour, so you can tell a
// touchdown from a flag even with a single light: slow swells, rising ramps,
// fast strobes, and fades to almost dark. Frames shorter than about 250 ms
// blur together on Hue lights, so nothing goes faster than that.
//
// `scale` stretches or shortens every show (0.6 short … 1.6 long).
export function buildEffect(kind, { primary = '#e31837', secondary = '#ffb612', opp = '#0a2343', bri = 254, scale = 1 } = {}) {
  const P = { xy: hexToXy(primary) };
  const S = { xy: hexToXy(secondary) };
  const O = { xy: hexToXy(opp) };
  const B = (b) => Math.max(1, Math.min(254, Math.round(b)));
  const at = (c, b) => ({ on: true, bri: B(b), ...c });
  const HI = 254;
  const DARK = 3; // nearly off, for contrast
  const DIM = Math.max(12, Math.round(bri * 0.12));
  const t = (ms) => Math.max(250, Math.round(ms * scale));

  // Building blocks. Each returns frames: { a, b?, ms }.
  const hold = (c, b, ms) => [{ a: at(c, b), ms: t(ms) }];
  const blink = (c, times, onMs, offMs, hi = HI, lo = DARK) => repeat(times, [{ a: at(c, hi), ms: t(onMs) }, { a: at(c, lo), ms: t(offMs) }]);
  // Alternating colours. With several lights, neighbours swap; with one light
  // it still changes colour, so the effect reads either way.
  const swap = (c1, c2, times, ms, b = HI) => repeat(times, [{ a: at(c1, b), b: at(c2, b), ms: t(ms) }, { a: at(c2, b), b: at(c1, b), ms: t(ms) }]);
  const ramp = (c, from, to, steps, totalMs) => Array.from({ length: steps }, (_, i) => ({ a: at(c, from + ((to - from) * (i + 1)) / steps), ms: t(totalMs / steps) }));
  const chase = (cs, times, ms) => repeat(times, cs.map((c, i) => ({ a: at(c, HI), b: at(cs[(i + 1) % cs.length], HI), ms: t(ms) })));

  switch (kind) {
    // ~10 s: three huge swells, a red/gold frenzy, gold glow, red.
    case 'td':
      return [
        ...repeat(3, [...hold(P, HI, 600), ...hold(P, DARK, 400)]),
        ...swap(P, S, 7, 300),
        ...ramp(S, 40, HI, 3, 900),
        ...hold(S, HI, 900),
        ...hold(P, HI, 1200),
      ];
    // ~7 s: gold climbs from dark to full (the kick rising), sparkles, holds.
    case 'fg':
      return [...hold(S, DARK, 400), ...ramp(S, 20, HI, 5, 2200), ...blink(WHITE, 3, 300, 300, HI, 60), ...hold(S, HI, 1800)];
    // ~6 s: red and white alarm.
    case 'safety':
      return [...swap(P, WHITE, 5, 450), ...hold(P, HI, 1500)];
    // ~8 s: fast gold strobe like a siren, then red, then gold.
    case 'takeaway':
      return [...blink(S, 9, 260, 260), ...hold(P, HI, 1200), ...hold(S, HI, 2000)];
    // ~6 s: two hard white hits, then pounding red.
    case 'sack':
      return [...blink(WHITE, 2, 300, 300), ...blink(P, 4, 400, 350), ...hold(P, HI, 1200)];
    // ~5 s: gold and red sweep.
    case 'bigPlay':
      return [...chase([S, P, S, P], 2, 450), ...hold(S, HI, 1600)];
    // ~8 s: their colour takes over, then everything sinks to a dim red.
    case 'oppTd':
      return [...hold(O, HI, 2200), ...ramp(O, HI, DIM, 3, 1800), ...hold(P, DARK, 1500), ...ramp(P, DARK, bri * 0.5, 3, 2000)];
    // ~6 s: their colour, then a dim red.
    case 'oppFg':
      return [...hold(O, HI, 2000), ...ramp(O, HI, DIM, 2, 1500), ...ramp(P, DIM, bri * 0.6, 3, 2000)];
    // ~6 s: a slow groan down to near dark.
    case 'giveaway':
      return [...ramp(P, HI, DARK, 4, 2400), ...hold(P, DARK, 1600), ...ramp(P, DARK, bri * 0.6, 3, 1800)];
    // ~6 s: yellow flag waving.
    case 'flag':
      return [...blink(YELLOW, 6, 400, 350, HI, 25), ...hold(YELLOW, HI, 1500)];
    // ~5 s: white builds like the run-up to the kick, a burst, then red.
    case 'kickoff':
      return [...ramp(WHITE, 20, HI, 4, 2000), ...blink(WHITE, 2, 300, 300, HI, 40), ...hold(P, HI, 1900)];
    // ~30 s party.
    case 'win':
      return [...swap(P, S, 12, 400), ...repeat(3, [...ramp(S, 40, HI, 2, 1000), ...hold(P, HI, 1000)]), ...blink(S, 8, 300, 300), ...hold(S, HI, 3000)];
    // ~12 s: a slow fade to dim red.
    case 'loss':
      return [...ramp(P, bri, DARK, 5, 5000), ...hold(P, DARK, 3000), ...ramp(P, DARK, DIM, 2, 3000)];
    case 'identify':
      return blink(WHITE, 3, 350, 350, HI, 5);
    default:
      return null;
  }
}

export const SHOW_LENGTHS = { short: 0.6, normal: 1, long: 1.5 };

export const effectLength = (frames) => (frames || []).reduce((t, f) => t + f.ms, 0);
