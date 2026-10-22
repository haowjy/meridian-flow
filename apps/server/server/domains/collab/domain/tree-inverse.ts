/**
 * Tree entries in a document's edit history (moves, deletes, restores and settlements; D76,
 * PR 3): their stack facts, judged by state, never by row presence. An entry is undoable while
 * its destination still holds the state its latest application left; redoable while it still
 * holds the state its undo left; applied or discarded only when a later settlement row says so.
 */
import type {
  BranchId,
  BranchTreeFacts,
  DocumentId,
  LiveTreeState,
  ThreadId,
  TreeChange,
  TreeChangeDestination,
  TreeChangeOp,
  TreePlacement,
  TurnId,
} from "@meridian/contracts";

export type StoredTreeEntry = {
  /** The entry's `seq`: its place on the same axis as text parts' ids. */
  id: number;
  editId: string;
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  editScopeId: string | null;
  actor: "agent" | "human" | "system";
  wId: number | null;
  kind: "write" | "undo" | "redo" | "revert" | "rollback";
  actionId: string | null;
  consumes: string[];
  /** `tree.targets`, here so the action index reads tree and text rows alike. */
  targets: TreeChange["targets"];
  tree: TreeChange;
};

/** What a document's destinations hold now: live, and each branch with a tree entry here. */
export type TreeStates = {
  /** Null when the document is hidden (a branch's creation): no live entry can match it. */
  live: LiveTreeState | null;
  branches: ReadonlyMap<BranchId, BranchTreeFacts>;
};

/** One planned tree inverse: the entry, the transition it makes and the row it records. */
export type PlannedTreeInverse = {
  entry: StoredTreeEntry;
  direction: "invert" | "reapply";
  op: Exclude<TreeChangeOp, "settle">;
  destination: TreeChangeDestination;
  before: LiveTreeState | BranchTreeFacts;
  after: LiveTreeState | BranchTreeFacts;
  /** The removal a restore reverses, when the destination is live. */
  removal?: { time: string; locationVersion: string };
  /** The action the recorded row joins; the plan's own when absent. */
  actionId?: string;
};

/**
 * Why a tree inverse found its destination unable to take it at commit, under the locks: the
 * location is taken, its folder is gone, or a different removal is current.
 */
export type TreeInverseFault = "location_taken" | "folder_missing" | "superseded" | "refused";

/** A model inverse is all or nothing: a tree inverse that can't run refuses the whole command. */
export class TreeInverseRefused extends Error {
  constructor(
    readonly fault: TreeInverseFault,
    readonly planned: PlannedTreeInverse,
    readonly at?: string,
  ) {
    super(`A tree inverse met ${fault}`);
    this.name = "TreeInverseRefused";
  }
}

/** A tree entry's key in the effective action index; text parts key by ordinal. */
export const treeKey = (editId: string) => `${editId}:tree`;

export function samePlacement(a: TreePlacement, b: TreePlacement): boolean {
  return (
    a.folderId === b.folderId &&
    a.rootSourceId === b.rootSourceId &&
    a.name === b.name &&
    a.extension === b.extension
  );
}

function isLive(state: LiveTreeState | BranchTreeFacts): state is LiveTreeState {
  return "living" in state;
}

export function sameTreeState(
  a: LiveTreeState | BranchTreeFacts | null | undefined,
  b: LiveTreeState | BranchTreeFacts | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (isLive(a) || isLive(b)) {
    if (!isLive(a) || !isLive(b) || a.living !== b.living) return false;
    if (a.living && b.living) return samePlacement(a.at, b.at);
    if (!a.living && !b.living)
      return (
        a.removal.time === b.removal.time && a.removal.locationVersion === b.removal.locationVersion
      );
    return false;
  }
  return (
    a.row === b.row &&
    a.created === b.created &&
    a.deleted === b.deleted &&
    (a.moved === null ? b.moved === null : b.moved !== null && samePlacement(a.moved, b.moved))
  );
}

export function currentTreeState(
  states: TreeStates,
  destination: TreeChangeDestination,
): LiveTreeState | BranchTreeFacts | null {
  if (destination.kind === "live") return states.live;
  return (
    states.branches.get(destination.branchId) ?? {
      row: false,
      created: false,
      moved: null,
      deleted: false,
    }
  );
}

/**
 * The latest row that applied or reversed `entry` and was not itself rolled back: the entry,
 * or an undo, redo, revert or rollback naming it. Its `after` is what the destination holds
 * while nothing else changed it; its direction says whether the entry stands.
 */
export function latestTransition(
  entry: StoredTreeEntry,
  tree: readonly StoredTreeEntry[],
  rolledBack: ReadonlySet<string>,
): { row: StoredTreeEntry; stands: boolean } {
  let latest: { row: StoredTreeEntry; stands: boolean } = { row: entry, stands: true };
  for (const row of tree) {
    if (row.id <= latest.row.id || rolledBack.has(treeKey(row.editId))) continue;
    const target = row.targets.find((t) => t.editId === entry.editId);
    // A rollback row reverses the entry for good; the index already took it off the stack.
    if (target) latest = { row, stands: target.direction === "reapply" };
  }
  return latest;
}

/** The writer's Apply or Discard (or a cleanup) that ended a drafted entry, if one did. */
export function settlementOf(
  entry: StoredTreeEntry,
  tree: readonly StoredTreeEntry[],
): "applied" | "discarded" | null {
  let settled: { id: number; as: "applied" | "discarded" } | null = null;
  for (const row of tree)
    if (row.id > entry.id && row.tree.settles?.editIds.includes(entry.editId))
      if (!settled || row.id > settled.id) settled = { id: row.id, as: row.tree.settles.as };
  return settled?.as ?? null;
}

const INVERSE_OP = { move: "move", delete: "restore", restore: "delete" } as const;

/**
 * The transition that inverts (or reapplies) `entry`, from the state its latest transition left.
 * Null when that state no longer holds: the entry was built on.
 */
export function planTreeInverse(
  entry: StoredTreeEntry,
  direction: "invert" | "reapply",
  latest: StoredTreeEntry,
  current: LiveTreeState | BranchTreeFacts | null,
): PlannedTreeInverse | null {
  if (entry.tree.op === "settle" || !sameTreeState(current, latest.tree.after)) return null;
  const op = direction === "invert" ? INVERSE_OP[entry.tree.op] : entry.tree.op;
  const after = direction === "invert" ? entry.tree.before : entry.tree.after;
  const before = latest.tree.after;
  return {
    entry,
    direction,
    op,
    destination: entry.tree.destination,
    before,
    after,
    ...(op === "restore" && isLive(before) && !before.living ? { removal: before.removal } : {}),
  };
}

/** What a planned tree inverse did, in the model's words. */
export function treeInverseFact(planned: Pick<PlannedTreeInverse, "op" | "direction">): string {
  switch (planned.op) {
    case "move":
      return planned.direction === "invert" ? "moved back" : "moved again";
    case "restore":
      return "restored";
    case "delete":
      return "deleted again";
  }
}

/** A tree entry as a history line: what it did, where the model saw it. */
export function treeEntrySummary(entry: StoredTreeEntry): string {
  const at = entry.tree.shownAt ?? "";
  switch (entry.tree.op) {
    case "move":
      return `moved from ${at}`;
    case "delete":
      return `deleted ${at}`;
    case "restore":
      return `restored ${at}`;
    case "settle":
      return `settled ${at}`;
  }
}

/** A commit-time fault in the card's and the model's words. */
export function treeFaultReason(fault: TreeInverseFault, at?: string): string {
  switch (fault) {
    case "location_taken":
      return at ? `${at} is taken` : "its location is taken";
    case "folder_missing":
      return "its folder is gone";
    case "superseded":
      return "it was deleted again since";
    case "refused":
      return "it can't be restored here";
  }
}

/** Why a tree entry can't be reversed as it stands, for the model and the card. */
export function treeChangedReason(
  current: LiveTreeState | BranchTreeFacts | null,
): "deleted since" | "moved since" | "changed since" {
  if (current && "living" in current) return current.living ? "moved since" : "deleted since";
  return "changed since";
}
