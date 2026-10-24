/**
 * Planning a row drop. Sources are identities; where each one sits is read
 * from the replica's placement graph at the moment of asking, so a row another
 * list dragged, or a peer renamed or moved, is judged as it is now. Pure and
 * synchronous: hovering plans on every `dragover`.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type {
  ParentRef,
  ResourceLocation,
  ResourcePlacement,
  ResourceRecord,
} from "@meridian/resource-replica";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { schemeLabel } from "../context-schemes";
import { menuEntryFor } from "../menu-tree";
import type { MoveDestination } from "../move-entry";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import { type DragEntry, type EntryRef, entrySystem } from "./entry";

/** A catalog a list shows, and so a place a drop can land. */
export type MoveArea = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  /** The owner accepts moves (an archived Work's Scratch does not). */
  movable: boolean;
};

/** The project's current placement: every catalog and folder journal, not just what a list shows. */
export type PlacementView = {
  records: readonly ResourceRecord[];
  placement: Pick<
    ResourcePlacement,
    "resourceLocation" | "parentForResource" | "folderLocation" | "parentForFolder"
  >;
};

export type MoveView = PlacementView & { areas: readonly MoveArea[] };

/** An entry as the replica places it now. */
export type PlacedEntry = {
  ref: EntryRef;
  name: string;
  location: ResourceLocation;
  parent: ParentRef;
};

/** One row the replica admitted: where it was, where it went, and the name it arrived under. */
export type MoveEffect = {
  entry: EntryRef;
  name: string;
  before: ParentRef;
  after: ParentRef;
};

export type MovePlan =
  | { kind: "none" }
  /** A folder over its own subtree; the only drop that refuses rather than doing nothing. */
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destination: MoveDestination;
      destinationName: string;
      /** Each row as placed now; its parent is where Undo returns it. */
      moves: readonly PlacedEntry[];
    };

export type ReadyMovePlan = Extract<MovePlan, { kind: "ready" }>;

const NONE: MovePlan = { kind: "none" };

/** Where `ref` sits now, or null when it is gone or its parent isn't known yet. */
export function placeEntryRef(
  { records, placement }: PlacementView,
  ref: EntryRef,
): PlacedEntry | null {
  if (ref.kind === "folder") {
    const location = placement.folderLocation(ref.id);
    const parent = placement.parentForFolder(ref.id);
    return location && parent ? { ref, name: location.name, location, parent } : null;
  }
  const record = records.find((candidate) => candidate.resource.identity.documentId === ref.id);
  const location = record ? placement.resourceLocation(record) : null;
  if (!record || !location) return null;
  const parent = placement.parentForResource(record);
  return parent ? { ref, name: location.name, location, parent } : null;
}

/** Whether `folderId` is `start` itself or sits above it. */
function within(view: PlacementView, start: ParentRef | null, folderId: string): boolean {
  const seen = new Set<string>();
  let parent = start;
  while (parent?.kind === "folder" && !seen.has(parent.folderId)) {
    if (parent.folderId === folderId) return true;
    seen.add(parent.folderId);
    parent = view.placement.parentForFolder(parent.folderId);
  }
  return false;
}

/** A folder carries its contents, so a row inside a carried folder is dropped from the carry. */
export function withoutNested<T extends { ref: EntryRef }>(view: PlacementView, items: T[]): T[] {
  const folders = items.filter((item) => item.ref.kind === "folder");
  return items.filter((item) => {
    const placed = placeEntryRef(view, item.ref);
    return !folders.some(
      (folder) => folder !== item && within(view, placed?.parent ?? null, folder.ref.id),
    );
  });
}

type OwnerLike = { workId?: string | null; rootThreadId?: string | null };
type Parent = ParentRef | { kind: "root"; scheme: ProjectContextTreeScheme; owner: OwnerLike };

/** The same folder, or the same area top level (project areas ignore the owner). */
export function sameParent(a: Parent, b: Parent): boolean {
  if (a.kind === "folder") return b.kind === "folder" && a.folderId === b.folderId;
  return (
    b.kind === "root" &&
    a.scheme === b.scheme &&
    (isProjectScopedScheme(a.scheme) ||
      ((a.owner.workId ?? null) === (b.owner.workId ?? null) &&
        (a.owner.rootThreadId ?? null) === (b.owner.rootThreadId ?? null)))
  );
}

/** What dropping `entries` on `target` would do: move, refuse with a reason, or nothing. */
export function planMove(
  view: MoveView,
  entries: readonly DragEntry[],
  target: TreeDropTarget,
): MovePlan {
  const area = view.areas.find(
    (candidate) => candidate.catalog.root.entryId === target.catalogRootId,
  );
  if (!area?.movable || target.scheme !== area.scheme) return NONE;
  // A selection holding a row without Move moves nowhere, rather than silently leaving rows behind.
  if (!entries.every((entry) => entry.movable)) return NONE;
  const { scheme, owner, catalog } = area;
  const folder = target.folder ? menuEntryFor(catalog, target.folder.entryId) : null;
  if (target.folder && (folder?.kind !== "dir" || folder.navigationOnly)) return NONE;
  const destination: MoveDestination = {
    scheme,
    owner,
    catalog,
    entryId: target.folder?.entryId ?? catalog.root.entryId,
    path: target.folder?.path ?? "/",
  };
  const destinationName = target.folder?.name ?? schemeLabel(scheme);
  const sources = withoutNested(view, [...entries]).flatMap((entry) => {
    const placed = placeEntryRef(view, entry.ref);
    return placed ? [placed] : [];
  });
  // The project areas are one system, each owner's Scratch its own; crossing is Move or Copy.
  const system = entrySystem(scheme, owner);
  if (sources.some((source) => entrySystem(source.location.scheme, source.location) !== system))
    return NONE;

  const into: Parent = target.folder
    ? { kind: "folder", folderId: target.folder.entryId }
    : { kind: "root", scheme: area.scheme, owner: area.owner };
  if (
    sources.some(
      (source) =>
        source.ref.kind === "folder" && into.kind === "folder" && within(view, into, source.ref.id),
    )
  )
    return { kind: "inside-itself" };
  // Rows already there stay put; a taken name never refuses (the row arrives at the next free name).
  const moves = sources.filter((source) => !sameParent(source.parent, into));
  return moves.length === 0 ? NONE : { kind: "ready", destination, destinationName, moves };
}

/**
 * What Undo puts back. A row still where the drop put it returns to its
 * previous parent under its current name (the next free one if that name was
 * taken since); one that moved again since, or is gone, carries the writer's
 * newer choice and stays. (Parent equality can't tell a row that left and came
 * back from one that never left; both return.)
 */
export function planUndo(view: PlacementView, effects: readonly MoveEffect[]) {
  return effects.flatMap((effect) => {
    const now = placeEntryRef(view, effect.entry);
    return now && sameParent(now.parent, effect.after)
      ? [{ entry: effect.entry, name: now.name, before: effect.after, after: effect.before }]
      : [];
  });
}
