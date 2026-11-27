// A twin suffix always ends the segment; stored names cannot end in that shape
export const SEGMENT_SUFFIX = /~([0-9a-f]{4,})$/i;

export type Segment = {
  name: string;
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

export function idHex(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

export type Walkable = {
  id: string;
  kind: string;
  name: string;
  suffix?: string | undefined;
  trashed: boolean;
};

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

export function withSegmentName(leaf: string, read: (name: string) => string): string {
  const { name, suffix } = readSegment(leaf);
  return entrySegment(read(name), suffix);
}
