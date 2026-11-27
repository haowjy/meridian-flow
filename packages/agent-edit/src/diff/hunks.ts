import type { Tok } from "./tokens.js";

export interface Hunk {
  from: number;
  to: number;
  sfrom: number;
  sto: number;
  ins: Tok[];
  sidx?: number[];
}

export function posMap(n: number, hunks: readonly Hunk[]): Int32Array {
  const pos = new Int32Array(n).fill(-1);
  let b0 = 0;
  let s0 = 0;
  for (const h of hunks) {
    while (b0 < h.from) pos[b0++] = s0++;
    b0 = h.to;
    s0 = h.sto;
  }
  while (b0 < n) pos[b0++] = s0++;
  return pos;
}
