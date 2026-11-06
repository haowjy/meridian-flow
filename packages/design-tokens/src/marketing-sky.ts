/** Linear RGB colours of the landing page's WebGL sky, which CSS tokens can't reach. */
export type LinearRgb = readonly [number, number, number];

export const MARKETING_SKY = {
  skyTop: [0.005, 0.02, 0.024],
  skyMid: [0.012, 0.055, 0.058],
  skyHaze: [0.035, 0.15, 0.135],
  horizonGlow: [0.28, 0.95, 0.74],
  auroraLow: [0.16, 0.95, 0.66],
  auroraHigh: [0.12, 0.55, 0.7],
  auroraBand: [0.1, 0.5, 0.55],
  seaGlow: [0.14, 0.8, 0.6],
  seaDeep: [0.005, 0.011, 0.018],
  dawnSky: [0.06, 0.15, 0.17],
  sun: [1, 0.8, 0.5],
  veil: [0.012, 0.02, 0.034],
  starCool: [0.74, 0.84, 1],
  starWarm: [1, 0.86, 0.68],
  meridianLine: [0.5, 0.56, 0.6],
} as const satisfies Record<string, LinearRgb>;

/** The sky's darkest tone, for the browser's own chrome. */
export const MARKETING_THEME_COLOR = "#06100f";
