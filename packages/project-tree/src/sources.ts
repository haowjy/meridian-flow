import { isSourceRoot, sourceIdOf, type TreeRecord } from "./record.js";
import type { TreeProjection } from "./replay.js";

/** Where a node stands, by view: `undefined` when the view has no such node. */
export type ParentOf = (draft: string | null, node: string) => string | undefined;

/**
 * Walks records in order and gives each, to `visit`, the sources it changes: a create the one it
 * lands in (its folder's, or its own `source` when the folder is in no view, rule 6); a move its
 * node's and its destination's; any other record its node's. A delete's cascade and a restore's
 * lift are below the node, in its source. A node's source is where it stands at that record, after
 * the records before it: a create places its node, and a move places its node when `visit` says
 * it lands (a move that would put a folder inside itself never does: replay skips it). Live's
 * placements show in every draft; a draft's only in its own. `changes` is lazy: a caller that
 * judges nothing by source pays for no replay.
 */
export function walkSources(
  records: readonly TreeRecord[],
  parentBefore: ParentOf,
  visit: (record: TreeRecord, changes: () => string[]) => boolean,
): void {
  const placed = new Map<string | null, Map<string, string>>();
  const placedIn = (draft: string | null) => {
    const map = placed.get(draft) ?? new Map<string, string>();
    placed.set(draft, map);
    return map;
  };
  const parentOf = (draft: string | null, node: string) =>
    (draft === null ? undefined : placedIn(draft).get(node)) ??
    placedIn(null).get(node) ??
    parentBefore(draft, node);
  const sourceOf = (draft: string | null, place: string): string | undefined => {
    const seen = new Set<string>();
    for (let at: string | undefined = place; at !== undefined; at = parentOf(draft, at)) {
      if (isSourceRoot(at)) return sourceIdOf(at);
      if (seen.has(at)) return undefined;
      seen.add(at);
    }
    return undefined;
  };
  const intoItself = (draft: string | null, node: string, parent: string) => {
    const seen = new Set<string>();
    for (let at: string | undefined = parent; at !== undefined && !isSourceRoot(at); ) {
      if (at === node || seen.has(at)) return true;
      seen.add(at);
      at = parentOf(draft, at);
    }
    return false;
  };
  for (const record of records) {
    if (record.type === "purge") continue;
    const { draft } = record;
    const changes = () => {
      const places =
        record.type === "create"
          ? [sourceOf(draft, record.parent) ?? record.source]
          : record.type === "move"
            ? [sourceOf(draft, record.node), sourceOf(draft, record.parent)]
            : [sourceOf(draft, record.node)];
      return [...new Set(places.flatMap((source) => (source === undefined ? [] : [source])))];
    };
    const lands = visit(record, changes);
    if (record.type === "create") placedIn(draft).set(record.node, record.parent);
    else if (record.type === "move" && lands && !intoItself(draft, record.node, record.parent))
      placedIn(draft).set(record.node, record.parent);
  }
}

/** Where a projection has each node, for `walkSources` over records that land on it. */
export const parentIn =
  (projection: TreeProjection): ParentOf =>
  (_draft, node) =>
    projection.nodes.get(node)?.parent;

/**
 * Every source the records could change, landing on `projection` or taken back from it: each
 * one's node and, for a create or a move, the folders it leaves and goes to, both where
 * `projection` has them now and where the records before it place them. More than any one
 * command changes, so a caller that must lock the owners before it reads the list under its key
 * can take them all first.
 */
export function sourcesTouched(
  projection: TreeProjection,
  records: readonly TreeRecord[],
): Set<string> {
  const out = new Set<string>();
  const sourceOfPlace = (place: string) =>
    isSourceRoot(place) ? sourceIdOf(place) : projection.nodes.get(place)?.source;
  const add = (source: string | undefined) => {
    if (source !== undefined) out.add(source);
  };
  walkSources(records, parentIn(projection), (_record, changes) => {
    for (const source of changes()) out.add(source);
    return true;
  });
  for (const record of records) {
    add(projection.nodes.get(record.node)?.source);
    if (record.type === "create" || record.type === "move") add(sourceOfPlace(record.parent));
    if (record.type === "move") add(sourceOfPlace(record.from.parent));
  }
  return out;
}
