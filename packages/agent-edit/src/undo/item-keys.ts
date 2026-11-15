import * as Y from "yjs";
import { findItem } from "../yjs-mutation.js";

/** One character's Yjs id, `client:clock`. */
export type Key = string;
interface ClockRange {
  client: number;
  clock: number;
  len: number;
}
export const key = (id: { client: number; clock: number }): Key => `${id.client}:${id.clock}`;
export const parse = (k: Key): Y.ID => {
  const separator = k.indexOf(":");
  return Y.createID(Number(k.slice(0, separator)), Number(k.slice(separator + 1)));
};
export const clocks = (ranges: readonly ClockRange[]): Key[] =>
  ranges.flatMap((r) =>
    Array.from({ length: r.len }, (_, n) => key({ client: r.client, clock: r.clock + n })),
  );
/** Sorted by client and clock, adjacent clocks merged. */
export function ranges(keys: Iterable<Key>): ClockRange[] {
  const sorted = [...new Set(keys)]
    .map(parse)
    .sort((a, b) => a.client - b.client || a.clock - b.clock);
  const out: ClockRange[] = [];
  for (const id of sorted) {
    const last = out.at(-1);
    if (last?.client === id.client && last.clock + last.len === id.clock) last.len++;
    else out.push({ ...id, len: 1 });
  }
  return out;
}
export const find = (doc: Y.Doc, k: Key) => findItem(doc, parse(k)) ?? undefined;
