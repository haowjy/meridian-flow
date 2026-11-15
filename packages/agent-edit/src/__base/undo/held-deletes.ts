import * as Y from "yjs";

/**
 * The clocks of `novel`'s delete set that `doc` already holds deleted. Only the part of each
 * range below the before-frontier names structs `doc` has; a clock at or past it is inserted by
 * this update or unknown, and the apply decides it (integrated, or pending: prefix-missing).
 */
export function heldDeletes(
  doc: Y.Doc,
  novel: Uint8Array,
  frontier: Map<number, number>,
): Set<string> {
  const held = new Set<string>();
  for (const [client, ranges] of Y.decodeUpdate(novel).ds.clients) {
    const known = frontier.get(client) ?? 0;
    for (const { clock, len } of ranges) {
      const end = Math.min(clock + len, known);
      for (let at = clock; at < end; ) {
        const struct = Y.getItem(doc.store, Y.createID(client, at));
        const structEnd = Math.min(struct.id.clock + struct.length, end);
        if (struct.deleted) for (let c = at; c < structEnd; c += 1) held.add(`${client}:${c}`);
        at = structEnd;
      }
    }
  }
  return held;
}

export function withoutClocks<R extends { client: number; clock: number; len: number }>(
  ranges: readonly R[],
  clocks: ReadonlySet<string> | undefined,
): R[] {
  if (!clocks?.size) return [...ranges];
  const out: R[] = [];
  for (const range of ranges) {
    let start: number | null = null;
    for (let clock = range.clock; clock <= range.clock + range.len; clock += 1) {
      const keep = clock < range.clock + range.len && !clocks.has(`${range.client}:${clock}`);
      if (keep && start === null) start = clock;
      if (!keep && start !== null) {
        out.push({ ...range, clock: start, len: clock - start });
        start = null;
      }
    }
  }
  return out;
}
