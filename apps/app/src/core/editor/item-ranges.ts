/**
 * Sets of Yjs item clocks, `[from, to)` per client: what a delete set removes, what an update
 * inserts, what a notice offered the writer.
 */
import * as Y from "yjs";

export type DeleteSet = Y.Transaction["deleteSet"];
/** Clock ranges per client, `[from, to)`. */
export type Ranges = Map<number, Array<[number, number]>>;
export type RangeList = Array<[client: number, from: number, to: number]>;

export function addRange(ranges: Ranges, client: number, from: number, to: number): void {
  if (to <= from) return;
  const list = ranges.get(client) ?? [];
  const last = list.at(-1);
  if (last && last[1] === from) last[1] = to;
  else list.push([from, to]);
  ranges.set(client, list);
}

export function rangesOf(deleteSet: DeleteSet): Ranges {
  const ranges: Ranges = new Map();
  for (const [client, items] of deleteSet.clients)
    for (const { clock, len } of items) addRange(ranges, client, clock, clock + len);
  return ranges;
}

/** `ranges` with `[from, to)` of `client` removed, as `[from, to)` pieces. */
export function without(
  from: number,
  to: number,
  removed: ReadonlyArray<[number, number]> | undefined,
): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[from, to]];
  for (const [start, end] of removed ?? [])
    pieces = pieces.flatMap(([a, b]) =>
      end <= a || start >= b
        ? [[a, b] as [number, number]]
        : [
            ...(a < start ? [[a, start] as [number, number]] : []),
            ...(end < b ? [[end, b] as [number, number]] : []),
          ],
    );
  return pieces;
}

export function within(
  ranges: Ranges,
  client: number,
  from: number,
  to: number,
): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  for (const [start, end] of ranges.get(client) ?? []) {
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a < b) kept.push([a, b]);
  }
  return kept;
}

/** Whether any clock of `a` is not in `b`. */
export function hasMoreThan(a: Ranges, b: Ranges): boolean {
  for (const [client, list] of a)
    for (const [from, to] of list) if (without(from, to, b.get(client)).length > 0) return true;
  return false;
}

export function listOf(ranges: Ranges): RangeList {
  return [...ranges].flatMap(([client, list]) =>
    list.map(([from, to]): [number, number, number] => [client, from, to]),
  );
}

export function addList(ranges: Ranges, list: RangeList): void {
  for (const [client, from, to] of list) addRange(ranges, client, from, to);
}

/** The items `update` inserts, skips and garbage collected structs aside. */
export function insertedBy(update: Uint8Array): Ranges {
  const ranges: Ranges = new Map();
  for (const struct of Y.decodeUpdate(update).structs)
    if (struct instanceof Y.Item)
      addRange(ranges, struct.id.client, struct.id.clock, struct.id.clock + struct.length);
  return ranges;
}
