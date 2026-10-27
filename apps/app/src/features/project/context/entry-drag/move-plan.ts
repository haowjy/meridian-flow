/**
 * Planning a row drop. Sources are identities; where each one sits is read
 * from the replica's placement graph at the moment of asking, so a row another
 * list dragged, or a peer renamed or moved, is judged as it is now. Pure and
 * synchronous: hovering plans on every `dragover`.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type {
  ContextOwner,
  ContextSiblingPosition,
  CopyContextEntryView,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import {
  type FolderNamespaceRecord,
  type ParentRef,
  placementStillOwned,
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
import { type EntryDrag, type EntryRef, entrySystem } from "./entry";

/** A catalog a list shows, and so a place a drop can land. */
export type MoveArea = {
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  /** The owner accepts arrivals, by move or copy (an archived Work's Scratch does not). */
  accepts: boolean;
};

/** The project's current placement: every catalog and folder journal, not just what a list shows. */
export type PlacementView = {
  records: readonly ResourceRecord[];
  folders?: readonly FolderNamespaceRecord[];
  placement: Pick<
    ResourcePlacement,
    "resourceLocation" | "parentForResource" | "folderLocation" | "parentForFolder" | "childrenAt"
  >;
};

type WorkDirectory = readonly Pick<Work, "id" | "handle" | "archivedAt">[] | null | undefined;
type NoWork = Parameters<typeof destinationParent>[2];

export type MoveView = PlacementView & {
  areas: readonly MoveArea[];
  works: WorkDirectory;
  noWork: NoWork;
};

/** An entry as the replica places it now. */
export type PlacedEntry = {
  ref: EntryRef;
  name: string;
  location: ResourceLocation;
  parent: ParentRef;
};

export type SiblingPositionWitness = {
  beforeId?: string;
  afterId?: string;
};

/** The adjacent identities that let a later restoration survive intervening sibling changes. */
export function siblingPositionWitness(
  view: { records: readonly ResourceRecord[]; placement: Pick<ResourcePlacement, "childrenAt"> },
  parent: ParentRef,
  entryId: string,
): SiblingPositionWitness {
  const placed = view.placement.childrenAt(parent, view.records);
  const original = placed.findIndex((entry) => entry.entryId === entryId);
  if (original < 0) return {};
  const siblings = placed.filter((entry) => entry.entryId !== entryId);
  const before = siblings.find((_, index) => index >= original);
  const after = original > 0 ? siblings[original - 1] : undefined;
  return {
    ...(before ? { beforeId: before.entryId } : {}),
    ...(after ? { afterId: after.entryId } : {}),
  };
}

/** One row the replica admitted: where it was and under what name, where it went and the name it arrived under. */
export type MoveEffect = {
  entry: EntryRef;
  name: string;
  previousName: string;
  before: ParentRef;
  after: ParentRef;
  previousPosition: SiblingPositionWitness;
  action: "move" | "reorder";
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
  position?: ContextSiblingPosition;
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

/** The name `ref` carries now; null once the row is gone. */
export function entryNameNow({ records, placement }: PlacementView, ref: EntryRef): string | null {
  if (ref.kind === "folder") return placement.folderLocation(ref.id)?.name ?? null;
  const record = recordFor(records, ref.id);
  return (record && placement.resourceLocation(record)?.name) ?? null;
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

/**
 * The placed rows among `refs` that no other of them sits above, by where they are now: the rows
 * whose deletion takes the rest with them. A row that is gone or not placed yet is left out.
 */
export function outermostEntries(view: PlacementView, refs: readonly EntryRef[]): PlacedEntry[] {
  const placed = refs.flatMap((ref) => placeEntryRef(view, ref) ?? []);
  return dropNested(view, placed, (entry) => entry.parent);
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

/** A folder dropped on itself or anywhere below itself. */
function insideItself(view: PlacementView, source: PlacedEntry, into: ParentRef): boolean {
  return (
    source.ref.kind === "folder" && into.kind === "folder" && within(view, into, source.ref.id)
  );
}

function refusalFor(
  view: PlacementView,
  source: PlacedEntry,
  into: ParentRef,
  position?: ContextSiblingPosition,
): Refusal | null {
  if (insideItself(view, source, into)) return "inside-itself";
  return sameParent(source.parent, into) && !position ? "already-there" : null;
}

/**
 * Why `ref` can't move into `into`, judged by identity from the placement graph
 * (the same rule a drop uses); null when it can or when `ref` isn't placed yet.
 */
export function moveRefusal(
  view: PlacementView,
  ref: EntryRef,
  into: ParentRef,
  position?: ContextSiblingPosition,
): Refusal | null {
  const placed = placeEntryRef(view, ref);
  return placed ? refusalFor(view, placed, into, position) : null;
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

/** A carried entry as the replica places it now, with what a Copy of it reads. */
export type PlacedSource = PlacedEntry & { view: CopyContextEntryView };

/**
 * A drop, resolved: what the carried rows and the target are now, before any
 * action decides what to do with them. Move and Copy both plan from it, so
 * neither resolves identities again.
 */
export type ResolvedDrop = {
  /** The carried entries as the replica places them; one inside a carried folder rides with it and is left out. */
  sources: readonly PlacedSource[];
  /** The target's parent: a folder by ID, or an area's root with its authority. */
  into: ParentRef;
  destinationName: string;
  /** A sibling edge in `into`; absent when the folder or area itself is the target. */
  position?: ContextSiblingPosition;
  /**
   * The drop asks Move, Copy or Cancel instead of moving at once: some source sits in another
   * system than the target (the project's areas are one; User and each Scratch or Uploads owner
   * are their own), or the drag is a reference, which only a list row within one system outranks.
   */
  asks: boolean;
  /** A carried folder would land on itself or below itself. */
  insideItself: boolean;
  /** Carried rows the replica can't place now (gone, or their parent isn't known yet). Nothing acts on a selection that has lost rows. */
  unavailable: readonly EntryRef[];
  /** The target's scheme, for the records a Copy makes there. */
  scheme: ProjectContextTreeScheme;
  /**
   * Every carried row may Move. A row in an archived Work's Scratch is frozen: it can be copied
   * from, not moved out of. Judged here from where the replica places each row, so a drag source
   * never has to say.
   */
  canMove: boolean;
};

function movable(view: MoveView, { location }: PlacedEntry): boolean {
  const work =
    location.scheme === "scratch" && location.workId
      ? view.works?.find((candidate) => candidate.id === location.workId)
      : null;
  return !(work && isWorkArchived(work));
}

/**
 * Resolves dropping `drag` on `target` from the replica as it is now; null
 * when the target isn't a place a drop can land (no such area, an owner that
 * accepts no arrivals, a navigation-only folder, a parent not known yet).
 */
export function resolveDrop(
  view: MoveView,
  drag: EntryDrag,
  target: TreeDropTarget,
): ResolvedDrop | null {
  const area = view.areas.find(
    (candidate) => candidate.catalog.root.entryId === target.catalogRootId,
  );
  if (!area?.accepts || target.scheme !== area.scheme) return null;
  const { scheme, owner, catalog } = area;
  const folder = target.folder ? menuEntryFor(catalog, target.folder.entryId) : null;
  if (target.folder && (folder?.kind !== "dir" || folder.navigationOnly)) return null;
  const destination: MoveDestination = {
    scheme,
    owner,
    catalog,
    entryId: target.folder?.entryId ?? catalog.root.entryId,
  };
  const into = destinationParent(destination, view.works, view.noWork);
  if (!into) return null;
  const looked = drag.entries.map((entry) => ({
    ref: entry.ref,
    view: entry.view,
    now: placeEntryRef(view, entry.ref),
  }));
  const placed = looked.flatMap(({ now, view: read }) => (now ? [{ ...now, view: read }] : []));
  const sources = dropNested(view, placed, (source) => source.parent);
  const system = entrySystem(scheme, owner);
  return {
    sources,
    into,
    destinationName: folder?.name ?? schemeLabel(scheme),
    ...(target.position ? { position: target.position } : {}),
    asks:
      drag.source === "reference" ||
      sources.some((source) => entrySystem(source.location.scheme, source.location) !== system),
    insideItself: sources.some((source) => insideItself(view, source, into)),
    unavailable: looked.flatMap(({ ref, now }) => (now ? [] : [ref])),
    scheme,
    canMove: sources.every((source) => movable(view, source)),
  };
}

/**
 * What a resolved drop would do as a Move: move, refuse with a reason, or
 * nothing. A drop that asks plans like any other; whether to move at once
 * or ask first is the list's call (`resolved.asks`).
 */
export function planMove(view: PlacementView, resolved: ResolvedDrop | null): MovePlan {
  if (!resolved) return NONE;
  const { sources, into, destinationName, position } = resolved;
  // A selection holding a row without Move, or one that lost a row, moves nowhere rather than silently leaving rows behind.
  if (!resolved.canMove || resolved.unavailable.length > 0) return NONE;
  if (resolved.insideItself) return { kind: "inside-itself" };
  if (position) return planPositioned(view, sources, into, destinationName, position);
  // Rows already there stay put; a taken name never refuses (the row arrives at the next free name).
  const moves = sources.flatMap((source) =>
    sameParent(source.parent, into)
      ? []
      : [{ entry: source.ref, name: source.name, before: source.parent, after: into }],
  );
  return moves.length === 0 ? NONE : { kind: "ready", destinationName, moves };
}

/** One row a Copy duplicates: the row as it is named now, and the view it reads. */
export type CopyRow = { entry: EntryRef; name: string; view: CopyContextEntryView };

export type CopyPlan =
  | { kind: "none" }
  /** A folder copied over its own subtree: refused like a Move, with the same words. */
  | { kind: "inside-itself" }
  | {
      kind: "ready";
      destinationName: string;
      beside?: { kind: "before" | "after"; name: string };
      scheme: ProjectContextTreeScheme;
      into: ParentRef;
      position?: ContextSiblingPosition;
      copies: readonly CopyRow[];
    };

export type ReadyCopy = Extract<CopyPlan, { kind: "ready" }>;

/**
 * What a resolved drop would do as a Copy. Every carried row is copied, the one already in the
 * target's parent included (its copy takes the next free name), and an edge drop may anchor on a
 * carried row, which stays where it is. A selection that lost a row copies nothing.
 */
export function planCopy(view: PlacementView, resolved: ResolvedDrop | null): CopyPlan {
  if (!resolved || resolved.unavailable.length > 0 || resolved.sources.length === 0)
    return NONE_COPY;
  if (resolved.insideItself) return { kind: "inside-itself" };
  const { sources, into, destinationName, position, scheme } = resolved;
  const copies = sources.map((source) => ({
    entry: source.ref,
    name: source.name,
    view: source.view,
  }));
  if (!position) return { kind: "ready", destinationName, scheme, into, copies };
  if (!("siblingId" in position)) return NONE_COPY;
  const anchor = view.placement
    .childrenAt(into, view.records)
    .find((entry) => entry.entryId === position.siblingId);
  if (!anchor) return NONE_COPY;
  return {
    kind: "ready",
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
    scheme,
    into,
    position,
    copies,
  };
}

const NONE_COPY: CopyPlan = { kind: "none" };

/**
 * An edge drop: the carried rows land together, in screen order, beside the
 * anchor in `into`. The first takes the edge's position and each next one
 * follows the row before it, so "after" keeps their order. Neighbours come from
 * the parent's complete sibling sequence, not the rows a search leaves on
 * screen. Nothing happens when the anchor is itself carried or when every row
 * would end where it already is.
 */
function planPositioned(
  view: PlacementView,
  sources: readonly PlacedEntry[],
  into: ParentRef,
  destinationName: string,
  position: ContextSiblingPosition,
): MovePlan {
  if (!("siblingId" in position)) return NONE;
  const carried = new Set(sources.map((source) => source.ref.id));
  const siblings = view.placement.childrenAt(into, view.records);
  const anchor = siblings.find((entry) => entry.entryId === position.siblingId);
  if (!anchor || carried.has(anchor.entryId)) return NONE;
  if (sources.every((source) => sameParent(source.parent, into))) {
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
  const moves = sources.map((source, index) => {
    const previous = sources[index - 1];
    return {
      entry: source.ref,
      name: source.name,
      before: source.parent,
      after: into,
      position: previous ? ({ kind: "after", siblingId: previous.ref.id } as const) : position,
    };
  });
  return {
    kind: "ready",
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
    moves,
  };
}

/**
 * What Undo puts back. A row still where the drop put it, under the name it
 * arrived with, returns to its previous parent under its previous name (the
 * next free one if that was taken since); one renamed, moved again or gone
 * since carries the writer's newer choice and stays. (This can't tell a row
 * that left and came back from one that never left; both return.)
 */
export function planUndo(view: PlacementView, effects: readonly MoveEffect[]) {
  const eligible = effects.filter((effect) => {
    const now = placeEntryRef(view, effect.entry);
    if (!now) return false;
    return (
      now.name === effect.name &&
      sameParent(now.parent, effect.after) &&
      placementIsFresh(view, effect)
    );
  });
  const groups: MoveEffect[][] = [];
  for (const effect of eligible) {
    const group = groups.find((candidate) => {
      const first = candidate[0];
      return first ? sameParent(first.before, effect.before) : false;
    });
    if (group) group.push(effect);
    else groups.push([effect]);
  }
  return groups.flatMap((group) => planUndoGroup(view, group));
}

function planUndoGroup(view: PlacementView, effects: readonly MoveEffect[]): MoveRow[] {
  const first = effects[0];
  if (!first) return [];
  const pending = [...effects];
  const moving = new Set(pending.map((effect) => effect.entry.id));
  const working = view.placement
    .childrenAt(first.before, view.records)
    .map((entry) => entry.entryId)
    .filter((entryId) => !moving.has(entryId));
  const rows: MoveRow[] = [];
  while (pending.length > 0) {
    const index = restorationCandidate(pending, working);
    const [effect] = pending.splice(index, 1);
    if (!effect) break;
    const position = positionFromWitness(effect.previousPosition, working);
    insertWorking(working, effect.entry.id, position);
    rows.push({
      entry: effect.entry,
      name: effect.previousName,
      before: effect.after,
      after: effect.before,
      position,
    });
  }
  return rows;
}

function restorationCandidate(effects: readonly MoveEffect[], working: readonly string[]): number {
  const anchoredAfter = effects.findIndex(
    (effect) =>
      effect.previousPosition.afterId && working.includes(effect.previousPosition.afterId),
  );
  if (anchoredAfter >= 0) return anchoredAfter;
  const anchoredBefore = effects.findIndex(
    (effect) =>
      effect.previousPosition.beforeId && working.includes(effect.previousPosition.beforeId),
  );
  if (anchoredBefore >= 0) return anchoredBefore;
  const start = effects.findIndex(
    (effect) => !effect.previousPosition.afterId && Boolean(effect.previousPosition.beforeId),
  );
  if (start >= 0) return start;
  const end = effects.findIndex((effect) => !effect.previousPosition.beforeId);
  return end >= 0 ? end : 0;
}

/** Restore one removed row against the siblings that still exist now. */
export function positionFromWitness(
  witness: SiblingPositionWitness,
  working: readonly string[],
): ContextSiblingPosition {
  const { beforeId, afterId } = witness;
  if (afterId && working.includes(afterId)) return { kind: "after", siblingId: afterId };
  if (beforeId && working.includes(beforeId)) return { kind: "before", siblingId: beforeId };
  if (!afterId && beforeId) return { kind: "start" };
  return { kind: "end" };
}

function insertWorking(working: string[], entryId: string, position: ContextSiblingPosition): void {
  if (position.kind === "start") {
    working.unshift(entryId);
    return;
  }
  if (position.kind === "end") {
    working.push(entryId);
    return;
  }
  if (!("siblingId" in position)) return;
  const anchor = working.indexOf(position.siblingId);
  working.splice(position.kind === "before" ? anchor : anchor + 1, 0, entryId);
}

/** Whether the operation this effect admitted still owns its row's placement (the journal decides). */
function placementIsFresh(view: PlacementView, effect: MoveEffect): boolean {
  const holder =
    effect.entry.kind === "folder"
      ? view.folders?.find((folder) => folder.folderId === effect.entry.id)
      : recordFor(view.records, effect.entry.id);
  if (!holder) return Boolean(effect.operationId);
  const canonical = "resource" in holder ? holder.resource : holder;
  return placementStillOwned({
    intents: holder.intents,
    operationId: effect.operationId,
    canonicalLocationVersion: canonical.canonicalLocationVersion,
    canonicalObservationVersion: canonical.observationVersion,
  });
}

const UNANSWERED = new Set(["pending", "submitted", "received"]);

/**
 * Where the server stands on each operation a notice follows (a move, or the deletes an Undo
 * admitted). Refused: the row's intent for that operation settled as needs-repair, so the row
 * went back to where it was carrying the failure mark. Pending: unanswered, or not in this
 * projection yet (the replica admits an operation before its projection shows the intent).
 * Journals keep their intents, so a missing intent is never one that was pruned. Every other
 * state (accepted, superseded by the writer's next change, cancelled) settled it for good, and
 * it is in neither list.
 */
export function intentSettlement<T extends { entry: EntryRef; operationId?: string }>(
  view: { records: readonly ResourceRecord[]; folders: readonly FolderNamespaceRecord[] },
  followed: readonly T[],
): { refused: T[]; pending: T[] } {
  const refused: T[] = [];
  const pending: T[] = [];
  for (const item of followed) {
    if (!item.operationId) continue;
    const intents =
      item.entry.kind === "folder"
        ? view.folders.find((folder) => folder.folderId === item.entry.id)?.intents
        : recordFor(view.records, item.entry.id)?.intents;
    const state = intents?.find((intent) => intent.operationId === item.operationId)?.state;
    if (state === "needs-repair") refused.push(item);
    else if (!state || UNANSWERED.has(state)) pending.push(item);
  }
  return { refused, pending };
}
