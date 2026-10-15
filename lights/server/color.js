// Colour conversions for Hue lights: sRGB hex <-> CIE xy, and colour
// temperature (mireds) -> hex for showing a light's colour in the app.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toLinear = (c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function parseHex(hex) {
  const m = String(hex || '').trim().replace(/^#/, '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

export function hexToXy(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => toLinear(v / 255));
  // Philips' wide-gamut conversion, so colours look like they do in the Hue app.
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.329]; // black: use white's chromaticity
  return [round4(X / sum), round4(Y / sum)];
}

const round4 = (v) => Math.round(v * 10000) / 10000;

// Full-brightness sRGB for an xy colour (for display only).
export function xyToHex([x, y]) {
  if (!(y > 0)) return '#ffffff';
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b, 1e-9);
  [r, g, b] = [r, g, b].map((v) => toGamma(clamp(v / max, 0, 1)) * 255);
  return toHex([r, g, b]);
}

// Approximate sRGB for a colour temperature in mireds (153 cool .. 500 warm).
export function ctToHex(mired) {
  const k = 1e6 / clamp(mired || 366, 153, 500) / 100;
  const r = k <= 66 ? 255 : 329.698727446 * (k - 60) ** -0.1332047592;
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * (k - 60) ** -0.0755148492;
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  return toHex([r, g, b]);
}

export const MIRED_MIN = 153;
export const MIRED_MAX = 500;
