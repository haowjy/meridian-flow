/** Sorted, disjoint Yjs id intervals per client, each carrying a tag: "which range holds this id" in O(log n). */

export type ItemRange = readonly [client: number, clock: number, length: number];

export class IdIndex {
  private readonly byClient = new Map<number, { lo: number[]; hi: number[]; tag: number[] }>();

  /** Overlaps keep the lower-clock range's tag; equal starts keep input order. */
  constructor(
    ranges: Iterable<readonly [client: number, clock: number, length: number, tag: number]>,
  ) {
    const grouped = new Map<number, Array<[number, number, number]>>();
    for (const [client, clock, length, tag] of ranges) {
      if (length <= 0) continue;
      const list = grouped.get(client);
      if (list) list.push([clock, clock + length, tag]);
      else grouped.set(client, [[clock, clock + length, tag]]);
    }
    for (const [client, list] of grouped) {
      list.sort((a, b) => a[0] - b[0]);
      const out = { lo: [] as number[], hi: [] as number[], tag: [] as number[] };
      for (const [lo, hi, tag] of list) {
        const last = out.lo.length - 1;
        if (last >= 0 && lo < out.hi[last]) {
          if (hi <= out.hi[last]) continue;
          if (out.tag[last] === tag) {
            out.hi[last] = hi;
            continue;
          }
          out.lo.push(out.hi[last]);
        } else out.lo.push(lo);
        out.hi.push(hi);
        out.tag.push(tag);
      }
      this.byClient.set(client, out);
    }
  }

  /** Number of disjoint tagged intervals, after precedence has resolved overlaps. */
  get size(): number {
    return [...this.byClient.values()].reduce((sum, list) => sum + list.lo.length, 0);
  }

  /** Positive evidence needs any overlap, not full coverage. */
  overlaps(client: number, clock: number, length: number): boolean {
    if (length <= 0) return false;
    const [tag, run] = this.run(client, clock);
    return tag >= 0 || run < length;
  }

  /** The tag of the range holding this id, or -1. */
  get(client: number, clock: number): number {
    return this.run(client, clock)[0];
  }

  /** The tag at `clock` and how many ids keep that answer. */
  run(client: number, clock: number): readonly [tag: number, length: number] {
    const list = this.byClient.get(client);
    if (!list) return [-1, Number.POSITIVE_INFINITY];
    let a = 0;
    let b = list.lo.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (list.lo[m] <= clock) a = m + 1;
      else b = m;
    }
    if (a > 0 && clock < list.hi[a - 1]) return [list.tag[a - 1], list.hi[a - 1] - clock];
    return [-1, list.lo[a] === undefined ? Number.POSITIVE_INFINITY : list.lo[a] - clock];
  }
}

/** Ranges tagged by their position in `sets`: `sets[i]` is tag `i`. */
export const indexRanges = (sets: ReadonlyArray<readonly ItemRange[]>) =>
  new IdIndex(sets.flatMap((set, tag) => set.map(([c, k, n]) => [c, k, n, tag] as const)));
