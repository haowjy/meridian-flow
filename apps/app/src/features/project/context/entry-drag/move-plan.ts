/**
 * Planning a row drop. Sources are identities; where each one sits is read from the trees the
 * list shows at the moment of asking, so a row another list dragged, or a peer renamed or
 * moved, is judged as it is now. Pure and synchronous: hovering plans on every `dragover`.
 */

import type {
  ContextOwner,
  ContextSiblingPosition,
  CopyContextEntryView,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { TreeDestination, TreeEntry, TreeView } from "@/core/project-tree/tree-view";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import { type EntryDrag, type EntryRef, entrySystem } from "./entry";

export type MoveArea = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  tree: TreeView;
  view?: CopyContextEntryView;
  writable: boolean;
};

export type PlacementView = { areas: readonly MoveArea[] };

export type PlacedEntry = {
  ref: EntryRef;
  name: string;
  parentId: string;
  area: MoveArea;
  entry: TreeEntry;
};

export type MoveRow = {
  entry: EntryRef;
  from: string;
};

export type MovePlan =
  | { kind: "none" }
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destinationName: string;
      beside?: { kind: "before" | "after"; name: string };
      to: TreeDestination;
      area: MoveArea;
      moves: readonly MoveRow[];
    };

export type ReadyMove = Extract<MovePlan, { kind: "ready" }>;

const NONE: MovePlan = { kind: "none" };

export const isAccountArea = (area: Pick<MoveArea, "scheme">) => area.scheme === "user";

const kindOf = (entry: TreeEntry): EntryRef["kind"] => (entry.kind === "dir" ? "folder" : "file");

export function placeEntryRef(view: PlacementView, ref: EntryRef): PlacedEntry | null {
  for (const area of view.areas) {
    const entry = area.tree.entry(ref.id);
    if (!entry || kindOf(entry) !== ref.kind) continue;
    return {
      ref,
      name: entry.name,
      parentId: entry.parentId ?? area.tree.root.entryId,
      area,
      entry,
    };
  }
  return null;
}

export function entryNameNow(view: PlacementView, ref: EntryRef): string | null {
  return placeEntryRef(view, ref)?.name ?? null;
}

export function within(area: MoveArea, parentId: string, folderId: string): boolean {
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current && !seen.has(current)) {
    if (current === folderId) return true;
    seen.add(current);
    current = area.tree.entry(current)?.parentId ?? null;
  }
  return false;
}

/**
 * Drops each item that sits inside another item's folder: a folder carries its contents, so
 * nothing a drag, Move… or Delete acts on is acted on twice.
 */
export function outermost<T extends { ref: EntryRef }>(
  view: PlacementView,
  items: readonly T[],
): T[] {
  const placed = items.map((item) => ({ item, at: placeEntryRef(view, item.ref) }));
  const folders = placed.filter(({ item }) => item.ref.kind === "folder");
  return placed
    .filter(
      ({ item, at }) =>
        !at ||
        !folders.some(
          (folder) => folder.item !== item && within(at.area, at.parentId, folder.item.ref.id),
        ),
    )
    .map(({ item }) => item);
}

export function parentName(area: MoveArea, parentId: string): string | null {
  if (parentId === area.tree.root.entryId) return schemeLabel(area.scheme);
  return area.tree.entry(parentId)?.name ?? null;
}

function insideItself(source: PlacedEntry, into: string): boolean {
  return source.ref.kind === "folder" && within(source.area, into, source.ref.id);
}

export function moveRefusal(
  view: PlacementView,
  ref: EntryRef,
  into: string,
  position?: ContextSiblingPosition,
): "inside-itself" | "already-there" | null {
  const placed = placeEntryRef(view, ref);
  if (!placed) return null;
  if (insideItself(placed, into)) return "inside-itself";
  return placed.parentId === into && !position ? "already-there" : null;
}

export type PlacedSource = PlacedEntry & { view: CopyContextEntryView };

/**
 * A drop, resolved: what the carried rows and the target are now, before any
 * action decides what to do with them. Move and Copy both plan from it, so
 * neither resolves identities again.
 */
export type ResolvedDrop = {
  sources: readonly PlacedSource[];
  into: string;
  area: MoveArea;
  destinationName: string;
  position?: ContextSiblingPosition;
  asks: boolean;
  insideItself: boolean;
  /** Carried rows no shown tree places now (gone). Nothing acts on a selection that has lost rows. */
  unavailable: readonly EntryRef[];
  scheme: ProjectContextTreeScheme;
  canMove: boolean;
  crossesLists: boolean;
};

export function resolveDrop(
  view: PlacementView,
  drag: EntryDrag,
  target: TreeDropTarget,
): ResolvedDrop | null {
  const area = view.areas.find((candidate) => candidate.tree.root.entryId === target.treeRootId);
  if (!area?.writable || target.scheme !== area.scheme) return null;
  const folder = target.folder ? area.tree.entry(target.folder.entryId) : null;
  if (target.folder && folder?.kind !== "dir") return null;
  const into = folder?.entryId ?? area.tree.root.entryId;
  const looked = drag.entries.map((entry) => ({
    ref: entry.ref,
    view: entry.view,
    now: placeEntryRef(view, entry.ref),
  }));
  const placed = looked.flatMap(({ now, view: read }) => (now ? [{ ...now, view: read }] : []));
  const sources = outermost(view, placed);
  const system = entrySystem(area.scheme, area.owner);
  return {
    sources,
    into,
    area,
    destinationName: folder?.name ?? schemeLabel(area.scheme),
    ...(target.position ? { position: target.position } : {}),
    asks:
      drag.source === "reference" ||
      sources.some((source) => entrySystem(source.area.scheme, source.area.owner) !== system),
    insideItself: sources.some((source) => insideItself(source, into)),
    unavailable: looked.flatMap(({ ref, now }) => (now ? [] : [ref])),
    scheme: area.scheme,
    canMove: sources.every((source) => source.area.writable),
    crossesLists: sources.some((source) => isAccountArea(source.area) !== isAccountArea(area)),
  };
}

export function planMove(resolved: ResolvedDrop | null): MovePlan {
  if (!resolved) return NONE;
  const { sources, into, area, destinationName, position } = resolved;
  // A selection holding a row without Move, or one that lost a row, moves nowhere rather than silently leaving rows behind.
  if (!resolved.canMove || resolved.unavailable.length > 0 || resolved.crossesLists) return NONE;
  if (resolved.insideItself) return { kind: "inside-itself" };
  if (position) return planPositioned(sources, resolved, position);
  const moves = sources.flatMap((source) => (source.parentId === into ? [] : [moveRowOf(source)]));
  return moves.length === 0
    ? NONE
    : { kind: "ready", destinationName, to: { parentId: into }, area, moves };
}

export type CopyRow = {
  entry: EntryRef;
  name: string;
  view: CopyContextEntryView;
  place: { scheme: ProjectContextTreeScheme; owner: ContextOwner; path: string };
};

export type CopyPlan =
  | { kind: "none" }
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destinationName: string;
      beside?: { kind: "before" | "after"; name: string };
      scheme: ProjectContextTreeScheme;
      area: MoveArea;
      into: string;
      position?: ContextSiblingPosition;
      copies: readonly CopyRow[];
    };

export type ReadyCopy = Extract<CopyPlan, { kind: "ready" }>;

/**
 * What a resolved drop would do as a Copy. Every carried row is copied, the one already in the
 * target's parent included, and an edge drop may anchor on a
 * carried row, which stays where it is. A selection that lost a row copies nothing.
 */
export function planCopy(resolved: ResolvedDrop | null): CopyPlan {
  if (!resolved || resolved.unavailable.length > 0 || resolved.sources.length === 0)
    return NONE_COPY;
  if (resolved.insideItself) return { kind: "inside-itself" };
  const { sources, into, area, destinationName, position, scheme } = resolved;
  const copies = sources.map((source) => ({
    entry: source.ref,
    name: source.name,
    view: source.view,
    place: { scheme: source.area.scheme, owner: source.area.owner, path: source.entry.path },
  }));
  if (!position) return { kind: "ready", destinationName, scheme, area, into, copies };
  if (!("siblingId" in position)) return NONE_COPY;
  const anchor = area.tree.children(into).find((entry) => entry.entryId === position.siblingId);
  if (!anchor) return NONE_COPY;
  return {
    kind: "ready",
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
    scheme,
    area,
    into,
    position,
    copies,
  };
}

const NONE_COPY: CopyPlan = { kind: "none" };

const moveRowOf = (source: PlacedEntry): MoveRow => ({ entry: source.ref, from: source.parentId });

/**
 * An edge drop: the carried rows land together, in screen order, beside the anchor in `into`.
 * Neighbours come from the parent's complete sibling sequence, not the rows a search leaves on
 * screen. Nothing happens when the anchor is itself carried or when every row would end where
 * it already is.
 */
function planPositioned(
  sources: readonly PlacedSource[],
  { into, area, destinationName }: ResolvedDrop,
  position: ContextSiblingPosition,
): MovePlan {
  if (!("siblingId" in position)) return NONE;
  const carried = new Set(sources.map((source) => source.ref.id));
  const siblings = area.tree.children(into);
  const anchor = siblings.find((entry) => entry.entryId === position.siblingId);
  if (!anchor || carried.has(anchor.entryId)) return NONE;
  if (sources.every((source) => source.parentId === into)) {
    const current = siblings.map((entry) => entry.entryId);
    const rest = current.filter((id) => !carried.has(id));
    const at = rest.indexOf(anchor.entryId) + (position.kind === "after" ? 1 : 0);
    const next = [
      ...rest.slice(0, at),
      ...sources.map((source) => source.ref.id),
      ...rest.slice(at),
    ];
    if (next.every((id, index) => id === current[index])) return NONE;
  }
  return {
    kind: "ready",
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
    to: { parentId: into, position },
    area,
    moves: sources.map(moveRowOf),
  };
}
