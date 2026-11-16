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

/** What a path walk reads of a node: a replay's node, or any catalog shaped like one. */
export type Walkable = {
  id: string;
  /** Only `"folder"` is read: a folder level of a path answers folders alone. */
  kind: string;
  name: string;
  suffix?: string | undefined;
  trashed: boolean;
};

/**
 * The shown child a path segment reaches. With a `~` suffix, the one whose id's hex digits begin
 * with it (the lowest id, should a suffix shortened by hand fit two), whatever name is in front;
 * a suffix that reaches none reads as the name in front, so a writer and a reader take a stale or
 * made-up `~id` the same way. By name, the child of that name that carries no suffix.
 *
 * `folder` reads a folder level of a path: only folders answer, and when the plain twin of the
 * name is a document, the folder of that name with the lowest id does (`Arc/x` reaches the folder
 * `Arc~922e` beside a document `Arc`). The SQL walk (`nodesAt`) reads the same.
 */
export function childAtSegment<N extends Walkable>(
  children: readonly N[],
  segment: string,
  level?: "folder",
): N | undefined {
  const { name, suffix } = readSegment(segment);
  let byId: N | undefined;
  let plain: N | undefined;
  let named: N | undefined;
  for (const child of children) {
    if (child.trashed || (level === "folder" && child.kind !== "folder")) continue;
    if (suffix !== undefined && idHex(child.id).startsWith(suffix)) {
      if (!byId || child.id < byId.id) byId = child;
    } else if (child.name === name) {
      if (child.suffix === undefined) plain = child;
      else if (level === "folder" && (!named || child.id < named.id)) named = child;
    }
  }
  return byId ?? plain ?? named;
}

/** A leaf with its suffix kept aside: `read` sees only the name, and its answer gets the suffix back. */
export function withSegmentName(leaf: string, read: (name: string) => string): string {
  const { name, suffix } = readSegment(leaf);
  return entrySegment(read(name), suffix);
}
