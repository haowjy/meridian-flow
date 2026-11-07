/** Linear RGB colours of the landing page's WebGL sky, which CSS tokens can't reach. */
export type LinearRgb = readonly [number, number, number];

export const MARKETING_SKY = {
  skyTop: [0.0015, 0.004, 0.012],
  skyHorizon: [0.006, 0.02, 0.028],
  auroraLow: [0.2, 1, 0.45],
  auroraMid: [0.08, 0.7, 0.55],
  auroraHigh: [0.32, 0.14, 0.75],
  auroraCore: [0.55, 0.5, 0.1],
  mountain: [0.012, 0.024, 0.03],
  sea: [0.004, 0.012, 0.016],
  dawnSky: [0.06, 0.15, 0.17],
  sun: [1, 0.8, 0.5],
  veil: [0.012, 0.02, 0.034],
  star: [0.8, 0.87, 1],
  fireCore: [0.85, 0.97, 1],
  fireHeart: [0.3, 0.72, 1],
  fireBody: [0.14, 0.88, 0.42],
  fireDeep: [0, 0.2, 0.1],
  fireEdge: [1, 0.46, 0.1],
  fireChar: [0.012, 0.012, 0.014],
} as const satisfies Record<string, LinearRgb>;

/** `--mkt-night` as hex, for the browser's own chrome. Mirrored in www's `site.webmanifest`. */
export const MARKETING_THEME_COLOR = "#010a0b";
