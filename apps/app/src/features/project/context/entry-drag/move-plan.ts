/**
 * Planning a row drop. Sources are identities; where each one sits is read
 * from the replica's placement graph at the moment of asking, so a row another
 * list dragged, or a peer renamed or moved, is judged as it is now. Pure and
 * synchronous: hovering plans on every `dragover`.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  type FolderNamespaceRecord,
  type ParentRef,
  type ResourceIdentityIndex,
  type ResourceLocation,
  type ResourcePlacement,
  type ResourceRecord,
  resourceIdentityIndex,
} from "@meridian/resource-replica";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { schemeLabel } from "../context-schemes";
import { menuEntryFor } from "../menu-tree";
import { destinationParent, type MoveDestination } from "../move-entry";
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
    "resourceLocation" | "parentForResource" | "folderLocation" | "parentForFolder" | "childrenAt"
  >;
};

type WorkDirectory = Parameters<typeof destinationParent>[1];
type NoWork = Parameters<typeof destinationParent>[2];

export type MoveView = PlacementView & {
  areas: readonly MoveArea[];
  works: WorkDirectory;
  noWork: NoWork;
};

/** An entry as the replica places it now. */
type PlacedEntry = {
  ref: EntryRef;
  name: string;
  location: ResourceLocation;
  parent: ParentRef;
};

/** One row the replica admitted: where it was and under what name, where it went and the name it arrived under. */
export type MoveEffect = {
  entry: EntryRef;
  name: string;
  previousName: string;
  before: ParentRef;
  after: ParentRef;
  /** The replica intent's operation; absent when the replica had nothing to change. */
  operationId?: string;
};

/** One row ready for `moveRows`: its current name and parent, and its resolved destination. */
export type MoveRow = {
  entry: EntryRef;
  name: string;
  /** A Move… retry keeps the writer's refused name; a drag uses the row's current name. */
  typed?: string;
  before: ParentRef;
  after: ParentRef;
};

type MovePlan =
  | { kind: "none" }
  /** A folder over its own subtree; the only drop that refuses rather than doing nothing. */
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destinationName: string;
      moves: readonly MoveRow[];
    };

const NONE: MovePlan = { kind: "none" };

// Hovering plans on every `dragover`; one index per snapshot keeps each plan linear in the selection.
const recordIndexes = new WeakMap<readonly ResourceRecord[], ResourceIdentityIndex>();

function recordFor(records: readonly ResourceRecord[], documentId: string) {
  let index = recordIndexes.get(records);
  if (!index) {
    index = resourceIdentityIndex(records);
    recordIndexes.set(records, index);
  }
  return index.byDocumentId(documentId);
}

/** Where `ref` sits now, or null when it is gone or its parent isn't known yet. */
function placeEntryRef({ records, placement }: PlacementView, ref: EntryRef): PlacedEntry | null {
  if (ref.kind === "folder") {
    const location = placement.folderLocation(ref.id);
    const parent = placement.parentForFolder(ref.id);
    return location && parent ? { ref, name: location.name, location, parent } : null;
  }
  const record = recordFor(records, ref.id);
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

/** The parent `ref` sits in now, or null when it is gone or not placed yet. */
export function parentOf(view: PlacementView, ref: EntryRef): ParentRef | null {
  return placeEntryRef(view, ref)?.parent ?? null;
}

/** Drops each item whose parent sits inside another carried folder. */
function dropNested<T extends { ref: EntryRef }>(
  view: PlacementView,
  items: readonly T[],
  parentOf: (item: T) => ParentRef | null,
): T[] {
  const folders = items.filter((item) => item.ref.kind === "folder");
  return items.filter((item) => {
    const parent = parentOf(item);
    return !folders.some((folder) => folder !== item && within(view, parent, folder.ref.id));
  });
}

/** A folder carries its contents, so a row inside a carried folder is dropped from the carry. */
type Refusal = "inside-itself" | "already-there";

function refusalFor(view: PlacementView, source: PlacedEntry, into: ParentRef): Refusal | null {
  if (source.ref.kind === "folder" && into.kind === "folder" && within(view, into, source.ref.id))
    return "inside-itself";
  return sameParent(source.parent, into) ? "already-there" : null;
}

/**
 * Why `ref` can't move into `into`, judged by identity from the placement graph
 * (the same rule a drop uses); null when it can or when `ref` isn't placed yet.
 */
export function moveRefusal(view: PlacementView, ref: EntryRef, into: ParentRef): Refusal | null {
  const placed = placeEntryRef(view, ref);
  return placed ? refusalFor(view, placed, into) : null;
}

/** The same folder, or the same area top level (project areas ignore the owner). */
export function sameParent(a: ParentRef, b: ParentRef): boolean {
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
  };
  const into = destinationParent(destination, view.works, view.noWork);
  if (!into) return NONE;
  const destinationName = target.folder?.name ?? schemeLabel(scheme);
  const placed = entries.flatMap((entry) => {
    const now = placeEntryRef(view, entry.ref);
    return now ? [now] : [];
  });
  const sources = dropNested(view, placed, (source) => source.parent);
  // The project areas are one system, each owner's Scratch its own; crossing is Move or Copy.
  const system = entrySystem(scheme, owner);
  if (sources.some((source) => entrySystem(source.location.scheme, source.location) !== system))
    return NONE;

  const refusals = sources.map((source) => refusalFor(view, source, into));
  if (refusals.includes("inside-itself")) return { kind: "inside-itself" };
  // Rows already there stay put; a taken name never refuses (the row arrives at the next free name).
  const moves = sources.flatMap((source, index) =>
    refusals[index] === null
      ? [
          {
            entry: source.ref,
            name: source.name,
            before: source.parent,
            after: into,
          },
        ]
      : [],
  );
  return moves.length === 0 ? NONE : { kind: "ready", destinationName, moves };
}

/**
 * What Undo puts back. A row still where the drop put it, under the name it
 * arrived with, returns to its previous parent under its previous name (the
 * next free one if that was taken since); one renamed, moved again or gone
 * since carries the writer's newer choice and stays. (This can't tell a row
 * that left and came back from one that never left; both return.)
 */
export function planUndo(view: PlacementView, effects: readonly MoveEffect[]) {
  return effects.flatMap((effect) => {
    const now = placeEntryRef(view, effect.entry);
    return now && now.name === effect.name && sameParent(now.parent, effect.after)
      ? [
          {
            entry: effect.entry,
            name: effect.previousName,
            before: effect.after,
            after: effect.before,
          },
        ]
      : [];
  });
}

const UNANSWERED = new Set(["pending", "submitted", "received"]);

/**
 * Where the server stands on each move. Refused: the row's intent for that
 * operation settled as needs-repair, so the row went back to where it came
 * from carrying the failure mark. Pending: unanswered, or not in this
 * projection yet (the replica admits a move before its projection shows the
 * intent). Journals keep their intents, so a missing intent is never one that
 * was pruned. Every other state (accepted, superseded by the writer's next
 * change, cancelled) settled it for good, and it is in neither list.
 */
export function moveSettlement(
  view: { records: readonly ResourceRecord[]; folders: readonly FolderNamespaceRecord[] },
  effects: readonly MoveEffect[],
): { refused: MoveEffect[]; pending: MoveEffect[] } {
  const refused: MoveEffect[] = [];
  const pending: MoveEffect[] = [];
  for (const effect of effects) {
    if (!effect.operationId) continue;
    const intents =
      effect.entry.kind === "folder"
        ? view.folders.find((folder) => folder.folderId === effect.entry.id)?.intents
        : recordFor(view.records, effect.entry.id)?.intents;
    const state = intents?.find((intent) => intent.operationId === effect.operationId)?.state;
    if (state === "needs-repair") refused.push(effect);
    else if (!state || UNANSWERED.has(state)) pending.push(effect);
  }
  return { refused, pending };
}
