/**
 * A path segment is a node's name, or a later twin's name and `~` and the start of its id's hex
 * digits (`Kael~b21c`, `map.png~b21c`): the suffix always ends the segment, after any extension.
 * A stored name never ends in this shape (`normalEntryName` turns its `~` into a look-alike), so
 * whatever ends in it is a suffix.
 */
export const SEGMENT_SUFFIX = /~([0-9a-f]{4,})$/i;

export type Segment = {
  /** The name, not checked when there is a suffix: the id decides. */
  name: string;
  /** Lowercase hex digits, without the `~`. */
  suffix?: string;
};

export function readSegment(segment: string): Segment {
  const match = SEGMENT_SUFFIX.exec(segment);
  if (!match) return { name: segment };
  return {
    name: segment.slice(0, match.index),
    suffix: (match[1] as string).toLowerCase(),
  };
}

export function entrySegment(name: string, suffix?: string | null): string {
  return suffix ? `${name}~${suffix}` : name;
}

/** A node id's hex digits, the uuid without its dashes: what a suffix is the start of. */
export function idHex(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

/** A leaf with its suffix kept aside: `read` sees only the name, and its answer gets the suffix back. */
export function withSegmentName(leaf: string, read: (name: string) => string): string {
  const { name, suffix } = readSegment(leaf);
  return entrySegment(read(name), suffix);
}
