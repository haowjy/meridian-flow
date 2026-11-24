/** Hunks: the token ranges `align` finds changed between two token sides. */
import type { Tok } from "./tokens.js";

export interface Hunk {
  from: number; // base token range replaced
  to: number;
  sfrom: number; // side token range this hunk came from: set where the hunk is made, never by a filter
  sto: number;
  ins: Tok[]; // the payload: all of sfrom..sto, or what a filter kept of it
  sidx?: number[]; // side index of each payload token once filtered (merge only)
}

/** Base token -> side token outside hunks, else -1. */
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
