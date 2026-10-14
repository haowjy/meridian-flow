/**
 * Planning a row drop. Sources are identities; where each one sits is read
 * from the replica's placement graph at the moment of asking, so a row another
 * list dragged, or a peer renamed or moved, is judged as it is now. Pure and
 * synchronous: hovering plans on every `dragover`.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  ownerOf,
  type ParentRef,
  type ResourceLocation,
  type ResourcePlacement,
  type ResourceRecord,
} from "@meridian/resource-replica";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { ContextEntrySibling } from "../context-entry-name";
import { schemeLabel } from "../context-schemes";
import { menuEntryFor } from "../menu-tree";
import { type MoveDestination, type MoveRefusal, nameRefusal } from "../move-entry";
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

export type PlannedMove = { ref: EntryRef; name: string; before: ParentRef };

/** One row the replica admitted: where it was, where it went, and the name it moved under. */
export type MoveEffect = {
  entry: EntryRef;
  name: string;
  before: ParentRef;
  after: ParentRef;
  operationId: string | null;
};

export type MovePlan =
  | { kind: "none" }
  | { kind: "refused"; refusal: MoveRefusal; name: string; destinationName: string }
  | {
      kind: "ready";
      destination: MoveDestination;
      destinationName: string;
      moves: readonly PlannedMove[];
    };

export type ReadyMovePlan = Extract<MovePlan, { kind: "ready" }>;

const NONE: MovePlan = { kind: "none" };

const recordIndexes = new WeakMap<readonly ResourceRecord[], Map<string, ResourceRecord>>();

function recordFor(records: readonly ResourceRecord[], documentId: string) {
  let index = recordIndexes.get(records);
  if (!index) {
    index = new Map(records.map((record) => [record.resource.identity.documentId, record]));
    recordIndexes.set(records, index);
  }
  return index.get(documentId);
}

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
  const record = recordFor(records, ref.id);
  const location = record ? placement.resourceLocation(record) : null;
  if (!record || !location) return null;
  // A document the server hasn't confirmed has no parent edge; one at an area's top level still has a home.
  const parent =
    placement.parentForResource(record) ??
    (location.path.lastIndexOf("/") === 0
      ? { kind: "root" as const, scheme: location.scheme, owner: ownerOf(location) }
      : null);
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

export function sameParent(a: ParentRef, b: ParentRef): boolean {
  if (a.kind === "folder") return b.kind === "folder" && a.folderId === b.folderId;
  return b.kind === "root" && a.scheme === b.scheme && sameOwner(a.owner, b.owner, a.scheme);
}

function sameOwner(
  a: { workId?: string | null; rootThreadId?: string | null },
  b: { workId?: string | null; rootThreadId?: string | null },
  scheme: ProjectContextTreeScheme,
): boolean {
  return (
    isProjectScopedScheme(scheme) ||
    ((a.workId ?? null) === (b.workId ?? null) &&
      (a.rootThreadId ?? null) === (b.rootThreadId ?? null))
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

  const moves: PlannedMove[] = [];
  const incoming: ContextEntrySibling[] = [];
  let refused: Extract<MovePlan, { kind: "refused" }> | null = null;
  for (const source of sources) {
    const refusal = refuse(view, source, area, destination, target, incoming);
    if (!refusal) {
      moves.push({ ref: source.ref, name: source.name, before: source.parent });
      incoming.push({
        entryId: source.ref.id,
        name: source.name,
        kind: source.ref.kind === "file" ? "file" : "dir",
      });
    } else if (refusal.kind !== "already-there")
      refused ??= { kind: "refused", refusal, name: source.name, destinationName };
  }
  if (refused) return refused;
  return moves.length === 0 ? NONE : { kind: "ready", destination, destinationName, moves };
}

function refuse(
  view: PlacementView,
  source: PlacedEntry,
  area: MoveArea,
  destination: MoveDestination,
  target: TreeDropTarget,
  incoming: readonly ContextEntrySibling[],
): MoveRefusal | null {
  const intoFolder: ParentRef | null = target.folder
    ? { kind: "folder", folderId: target.folder.entryId }
    : null;
  if (source.ref.kind === "folder" && within(view, intoFolder, source.ref.id))
    return { kind: "inside-itself" };
  const there = intoFolder
    ? sameParent(source.parent, intoFolder)
    : source.parent.kind === "root" &&
      source.parent.scheme === area.scheme &&
      sameOwner(source.parent.owner, area.owner, area.scheme);
  if (there) return { kind: "already-there" };
  return nameRefusal(destination, source.name, source.ref.kind, source.name, incoming);
}

/**
 * What Undo puts back. A row still where the drop put it returns to its
 * previous parent under its current name; one that moved again since, or is
 * gone, carries the writer's newer choice and stays. (Parent equality can't
 * tell a row that left and came back from one that never left; both return.)
 */
export function planUndo(view: PlacementView, effects: readonly MoveEffect[]) {
  return effects.flatMap((effect) => {
    const now = placeEntryRef(view, effect.entry);
    return now && sameParent(now.parent, effect.after)
      ? [{ entry: effect.entry, name: now.name, before: effect.after, after: effect.before }]
      : [];
  });
}
