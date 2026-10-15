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

// colors: { primary, secondary, opp } as hex. bri: the game brightness.
export function buildEffect(kind, { primary = '#e31837', secondary = '#ffb612', opp = '#0a2343', bri = 254 } = {}) {
  const P = { xy: hexToXy(primary) };
  const S = { xy: hexToXy(secondary) };
  const O = { xy: hexToXy(opp) };
  const at = (c, b) => ({ on: true, bri: Math.max(1, Math.min(254, Math.round(b))), ...c });
  const hi = 254;
  const lo = Math.max(10, Math.round(bri * 0.15));
  switch (kind) {
    case 'td':
      return [
        ...repeat(8, [
          { a: at(P, hi), b: at(S, hi), ms: 350 },
          { a: at(S, hi), b: at(P, hi), ms: 350 },
        ]),
        ...repeat(3, [
          { a: at(P, hi), ms: 450 },
          { a: at(P, lo), ms: 450 },
        ]),
        { a: at(P, hi), ms: 1200 },
      ];
    case 'fg':
      return repeat(3, [
        { a: at(S, hi), ms: 450 },
        { a: at(S, lo), ms: 450 },
      ]).concat([{ a: at(S, hi), ms: 900 }]);
    case 'safety':
      return repeat(4, [
        { a: at(P, hi), ms: 300 },
        { a: at(WHITE, hi), ms: 300 },
      ]);
    case 'takeaway':
      return repeat(6, [
        { a: at(S, hi), b: at(P, lo), ms: 250 },
        { a: at(P, lo), b: at(S, hi), ms: 250 },
      ]).concat([{ a: at(S, hi), ms: 1200 }]);
    case 'sack':
      return repeat(4, [
        { a: at(P, hi), ms: 220 },
        { a: at(P, lo), ms: 220 },
      ]);
    case 'bigPlay':
      return repeat(2, [
        { a: at(S, hi), ms: 300 },
        { a: at(P, hi), ms: 300 },
      ]);
    case 'oppTd':
      return [
        { a: at(O, Math.max(lo, bri * 0.6)), ms: 1800 },
        { a: at(P, lo), ms: 3500 },
      ];
    case 'oppFg':
      return [{ a: at(O, Math.max(lo, bri * 0.5)), ms: 1500 }];
    case 'giveaway':
      return [{ a: at(P, lo), ms: 3000 }];
    case 'flag':
      return repeat(3, [
        { a: at(YELLOW, hi), ms: 350 },
        { a: at(YELLOW, lo), ms: 350 },
      ]);
    case 'kickoff':
      return [
        { a: at(WHITE, hi), ms: 400 },
        { a: at(P, hi), ms: 400 },
        { a: at(WHITE, hi), ms: 400 },
      ];
    case 'win':
      return repeat(20, [
        { a: at(P, hi), b: at(S, hi), ms: 400 },
        { a: at(S, hi), b: at(P, hi), ms: 400 },
      ]).concat([{ a: at(S, hi), ms: 3000 }]);
    case 'loss':
      return [
        { a: at(P, lo), ms: 3000 },
        { a: at(P, Math.max(1, lo / 2)), ms: 6000 },
      ];
    case 'identify':
      return repeat(3, [
        { a: at(WHITE, hi), ms: 350 },
        { a: at(WHITE, 5), ms: 350 },
      ]);
    default:
      return null;
  }
}

export const effectLength = (frames) => (frames || []).reduce((t, f) => t + f.ms, 0);
