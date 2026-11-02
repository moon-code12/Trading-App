// Chart colours and the maths used to check them. Colours are never the only signal: candles also differ in
// shape (hollow or filled) and indicator lines differ in dash pattern.

// The chart background (Tailwind slate-900, the card colour).
export const BACKGROUND = '#0f172a';
export const TEXT = '#94a3b8'; // axis and secondary labels
export const TEXT_STRONG = '#e2e8f0';
export const GRID = '#1e293b';

export const PALETTES = {
  // The classic green and red.
  standard: { label: 'Standard (green / red)', up: '#34d399', down: '#fb7185' },
  // Blue and orange from the Okabe-Ito set, which stays distinct for the common kinds of colour blindness.
  accessible: { label: 'Colour-blind friendly (blue / orange)', up: '#56b4e9', down: '#e69f00' },
};

// Indicator lines. Near-white, reddish purple and bluish green stay clear of the blue and orange candles;
// `dash` keeps the lines apart without relying on colour.
export const INDICATOR_STYLES = {
  sma: { color: '#f8fafc', dash: undefined, label: 'SMA' },
  ema: { color: '#cc79a7', dash: '8 4', label: 'EMA' },
  bb: { color: '#4fd1a5', dash: '2 3', label: 'Bollinger Bands' },
  rsi: { color: '#e2e8f0', dash: undefined, label: 'RSI' },
  macd: { color: '#f8fafc', dash: undefined, label: 'MACD' },
  signal: { color: '#cc79a7', dash: '8 4', label: 'Signal' },
};

export const paletteFor = (name) => PALETTES[name] ?? PALETTES.standard;

// ---- Colour maths (WCAG contrast and CIE colour difference)

const toRgb = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toLinear = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => { const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, c)) * 255); };

export const luminance = (hex) => {
  const [r, g, b] = toRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// WCAG 2 contrast ratio, from 1 to 21.
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// How colours look with the main kinds of colour vision deficiency (Machado et al. 2009, full severity).
const MATRICES = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export const VISION_TYPES = Object.keys(MATRICES);

export function simulate(hex, type) {
  const rgb = toRgb(hex).map(toLinear);
  const m = MATRICES[type];
  const out = m.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]).map(toSrgb);
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const toLab = (hex) => {
  const [r, g, b] = toRgb(hex).map(toLinear);
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883,
  ];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = xyz.map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

// CIE76 colour difference: around 2 is just noticeable, 20 or more is clearly different.
export function deltaE(a, b) {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// The smallest difference between two colours across normal vision and each deficiency.
export const worstCaseDifference = (a, b) => Math.min(
  deltaE(a, b),
  ...VISION_TYPES.map((t) => deltaE(simulate(a, t), simulate(b, t))),
);
