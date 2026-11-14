/**
 * Planning a row drop. Sources are identities; where each one sits is read from the trees the
 * list shows at the moment of asking, so a row another list dragged, or a peer renamed or
 * moved, is judged as it is now. Pure and synchronous: hovering plans on every `dragover`.
 */

import type {
  ContextOwner,
  ContextSiblingPosition,
  CopyContextEntryView,
  NamedRow,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import type { TreeDestination, TreeEntry, TreeView } from "@/core/project-tree/tree-view";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import { type EntryDrag, type EntryRef, entrySystem } from "./entry";

/** A tree a list shows, and so a place a drop can land. */
export type MoveArea = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  tree: TreeView;
  /** The owner accepts arrivals, by move or copy (an archived Work's Scratch does not). */
  accepts: boolean;
};

/** The trees a list shows: what a drop is judged against. */
export type PlacementView = { areas: readonly MoveArea[] };

type WorkDirectory = readonly Pick<Work, "id" | "handle" | "archivedAt">[] | null | undefined;
type NoWork = { id: string } | null | undefined;

export type MoveView = PlacementView & {
  works: WorkDirectory;
  noWork: NoWork;
};

/** An entry as the trees place it now. */
export type PlacedEntry = {
  ref: EntryRef;
  name: string;
  /** The folder it sits in, or its source's id at the top. */
  parentId: string;
  area: MoveArea;
  entry: TreeEntry;
};

/** One row ready to move: its current name and parent, and where it goes. */
export type MoveRow = {
  entry: EntryRef;
  name: string;
  from: string;
  to: TreeDestination;
  /** The area it lands in; names the list that takes the record. */
  area: MoveArea;
  /** The file's naming facts, for the name it would arrive under; absent for a folder. */
  named?: NamedRow;
};

export type MovePlan =
  | { kind: "none" }
  /** A folder over its own subtree; the only drop that refuses rather than doing nothing. */
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destinationName: string;
      /** The sibling an edge drop lands beside, by name, for the hint. */
      beside?: { kind: "before" | "after"; name: string };
      moves: readonly MoveRow[];
    };

export type ReadyMove = Extract<MovePlan, { kind: "ready" }>;

const NONE: MovePlan = { kind: "none" };

/** Whether a tree belongs to the account's list (`user://`) rather than the project's. */
export const isAccountArea = (area: Pick<MoveArea, "scheme">) => area.scheme === "user";

/** A file's naming facts as its row shows them; a folder has none. */
export const namedRowOf = (entry: TreeEntry): NamedRow | undefined =>
  entry.kind === "file" ? { extension: entry.extension, editable: entry.editable } : undefined;

const kindOf = (entry: TreeEntry): EntryRef["kind"] => (entry.kind === "dir" ? "folder" : "file");

/** Where `ref` sits now, or null when it is gone from every tree the list shows. */
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

/** The name `ref` carries now; null once the row is gone. */
export function entryNameNow(view: PlacementView, ref: EntryRef): string | null {
  return placeEntryRef(view, ref)?.name ?? null;
}

/** Whether `folderId` is `parentId` itself or sits above it. */
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

/** A parent's name, or null once that folder is gone. */
export function parentName(area: MoveArea, parentId: string): string | null {
  if (parentId === area.tree.root.entryId) return schemeLabel(area.scheme);
  return area.tree.entry(parentId)?.name ?? null;
}

/** A folder dropped on itself or anywhere below itself. */
function insideItself(source: PlacedEntry, into: string): boolean {
  return source.ref.kind === "folder" && within(source.area, into, source.ref.id);
}

/**
 * Why `ref` can't move into `into`, judged by identity from the trees (the same rule a drop
 * uses); null when it can or when `ref` isn't placed yet.
 */
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

/** A carried entry as the trees place it now, with what a Copy of it reads. */
export type PlacedSource = PlacedEntry & { view: CopyContextEntryView };

/**
 * A drop, resolved: what the carried rows and the target are now, before any
 * action decides what to do with them. Move and Copy both plan from it, so
 * neither resolves identities again.
 */
export type ResolvedDrop = {
  /** The carried entries as the trees place them; one inside a carried folder rides with it and is left out. */
  sources: readonly PlacedSource[];
  /** The target's parent: a folder's id, or the id of the tree's source. */
  into: string;
  /** The tree the drop lands in. */
  area: MoveArea;
  destinationName: string;
  /** A sibling edge in `into`; absent when the folder or area itself is the target. */
  position?: ContextSiblingPosition;
  /**
   * The drop asks Move, Copy or Cancel instead of moving at once: some source sits in another
   * system than the target (the project's areas are one; User and each Scratch or Uploads
   * owner are their own), or the drag is a reference, which only a list row within one system outranks.
   */
  asks: boolean;
  /** A carried folder would land on itself or below itself. */
  insideItself: boolean;
  /** Carried rows no shown tree places now (gone). Nothing acts on a selection that has lost rows. */
  unavailable: readonly EntryRef[];
  /** The target's scheme, for the records a Copy makes there. */
  scheme: ProjectContextTreeScheme;
  /**
   * Every carried row may Move. A row in the Scratch of an archived Work, or of a Work the project
   * doesn't list, is frozen: it can be copied from, not moved out of.
   */
  canMove: boolean;
  /** A carried row is in the account's files and the target in a project, or the other way: a move there is a command the browser does not send, a copy is. */
  crossesLists: boolean;
};

/**
 * Fails closed: a row in a Work's Scratch may Move only when that Work is found and not
 * archived (No Work is never archived). A Work the project doesn't list (deleted, or the list
 * not loaded) freezes its Scratch rather than opening it.
 */
function movable(view: MoveView, { area }: PlacedEntry): boolean {
  const workId = area.owner.workId;
  if (area.scheme !== "scratch" || !workId) return true;
  if (workId === view.noWork?.id) return true;
  const work = view.works?.find((candidate) => candidate.id === workId);
  return Boolean(work && !isWorkArchived(work));
}

/**
 * Resolves dropping `drag` on `target` from the trees as they are now; null when the target
 * isn't a place a drop can land (no such area, an owner that accepts no arrivals, a folder that
 * is gone).
 */
export function resolveDrop(
  view: MoveView,
  drag: EntryDrag,
  target: TreeDropTarget,
): ResolvedDrop | null {
  const area = view.areas.find((candidate) => candidate.tree.root.entryId === target.treeRootId);
  if (!area?.accepts || target.scheme !== area.scheme) return null;
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
    canMove: sources.every((source) => movable(view, source)),
    crossesLists: sources.some((source) => isAccountArea(source.area) !== isAccountArea(area)),
  };
}

/**
 * What a resolved drop would do as a Move: move, refuse with a reason, or
 * nothing. A drop that asks plans like any other; whether to move at once
 * or ask first is the list's call (`resolved.asks`).
 */
export function planMove(resolved: ResolvedDrop | null): MovePlan {
  if (!resolved) return NONE;
  const { sources, into, area, destinationName, position } = resolved;
  // A selection holding a row without Move, or one that lost a row, moves nowhere rather than silently leaving rows behind.
  if (!resolved.canMove || resolved.unavailable.length > 0 || resolved.crossesLists) return NONE;
  if (resolved.insideItself) return { kind: "inside-itself" };
  if (position) return planPositioned(sources, resolved, position);
  // Rows already there stay put; a taken name never refuses (the row arrives at the next free name).
  const moves = sources.flatMap((source) =>
    source.parentId === into
      ? []
      : [
          {
            entry: source.ref,
            name: source.name,
            from: source.parentId,
            to: { parentId: into },
            area,
            named: namedRowOf(source.entry),
          },
        ],
  );
  return moves.length === 0 ? NONE : { kind: "ready", destinationName, moves };
}

/** One row a Copy duplicates: the row as it is named now, where it is read from, and the view it reads. */
export type CopyRow = {
  entry: EntryRef;
  name: string;
  view: CopyContextEntryView;
  /** Where the server finds the row: its tree's scheme and owner, and its path there. */
  place: { scheme: ProjectContextTreeScheme; owner: ContextOwner; path: string };
};

export type CopyPlan =
  | { kind: "none" }
  /** A folder copied over its own subtree: refused like a Move, with the same words. */
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destinationName: string;
      beside?: { kind: "before" | "after"; name: string };
      scheme: ProjectContextTreeScheme;
      /** The tree the copies land in. */
      area: MoveArea;
      /** The folder's id, or the source's id at the top. */
      into: string;
      position?: ContextSiblingPosition;
      copies: readonly CopyRow[];
    };

export type ReadyCopy = Extract<CopyPlan, { kind: "ready" }>;

/**
 * What a resolved drop would do as a Copy. Every carried row is copied, the one already in the
 * target's parent included (its copy takes the next free name), and an edge drop may anchor on a
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

/** Where among `into`'s children (without `carried`) an edge position falls, or null when its anchor is gone. */
export function indexAt(
  area: MoveArea,
  into: string,
  position: ContextSiblingPosition,
  carried: ReadonlySet<string>,
): number | null {
  if (!("siblingId" in position)) return null;
  const rest = area.tree
    .children(into)
    .filter((entry) => !carried.has(entry.entryId))
    .map((entry) => entry.entryId);
  const at = rest.indexOf(position.siblingId);
  return at < 0 ? null : at + (position.kind === "after" ? 1 : 0);
}

/**
 * An edge drop: the carried rows land together, in screen order, beside the anchor in `into`.
 * The first takes the edge's index and each next one follows it, so "after" keeps their order.
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
  const at = indexAt(area, into, position, carried);
  if (!anchor || carried.has(anchor.entryId) || at === null) return NONE;
  if (sources.every((source) => source.parentId === into)) {
    const current = siblings.map((entry) => entry.entryId);
    const rest = current.filter((id) => !carried.has(id));
    const next = [
      ...rest.slice(0, at),
      ...sources.map((source) => source.ref.id),
      ...rest.slice(at),
    ];
    if (next.every((id, index) => id === current[index])) return NONE;
  }
  const moves = sources.map((source, index) => ({
    entry: source.ref,
    name: source.name,
    from: source.parentId,
    to: { parentId: into, index: at + index },
    area,
    named: namedRowOf(source.entry),
  }));
  return {
    kind: "ready",
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
    moves,
  };
}
