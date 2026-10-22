/**
 * Tree entries in a document's edit history (moves, deletes, restores and settlements; D76,
 * PR 3): their stack facts, judged by state, never by row presence. An entry is undoable while
 * its destination still holds the state its latest application left; redoable while it still
 * holds the state its undo left; applied or discarded only when a later settlement row says so.
 */
import {
  type BranchId,
  type BranchTreeFacts,
  type BranchTreeTransition,
  type DocumentId,
  isLiveTransition,
  type LiveTreeState,
  sameBranchFacts,
  samePlacement,
  type ThreadId,
  type TreeChange,
  type TreeChangeDestination,
  type TreeChangeOp,
  type TreePlacement,
  type TreeRemoval,
  type TreeTransition,
  type TreeTransitionChange,
  type TurnId,
} from "@meridian/contracts";
import type { TreeReversalFault } from "@meridian/contracts/protocol";

export { sameBranchFacts, samePlacement };

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

/**
 * A live state as an inverse plans it. A removal that an earlier step of the same inverse makes
 * has no identity until that step runs: it names the step (`madeBy`) and the removal it stands
 * in for, the one its recorded transition expects, so a restore planned after it carries the
 * step's actual removal while a different removal still refuses it.
 */
export type PlannedLiveState =
  | LiveTreeState
  | { living: false; removal: TreeRemoval; madeBy: number };

/** What a document's destinations hold now: live, and each branch with a tree entry here. */
export type TreeStates = {
  /** Null when the document is hidden (a branch's creation): no live entry can match it. */
  live: PlannedLiveState | null;
  branches: ReadonlyMap<BranchId, BranchTreeFacts>;
};

/** A tree entry that moved, deleted or restored: one with a transition to reverse. */
export type TransitionEntry = StoredTreeEntry & { tree: TreeTransitionChange };

export const isTransitionEntry = <T extends Pick<StoredTreeEntry, "tree">>(
  row: T,
): row is T & { tree: TreeTransitionChange } => row.tree.op !== "settle";

/** A planned live transition starts where the inverse's earlier steps leave the document. */
export type PlannedLiveTransition = {
  destination: { kind: "live" };
  before: PlannedLiveState;
  after: LiveTreeState;
};

/** One planned tree inverse: the entry, the transition it makes and the step that makes it. */
export type PlannedTreeInverse = (PlannedLiveTransition | BranchTreeTransition) & {
  /** This step's number within its inverse, for a later step's `madeBy`. */
  step: number;
  entry: TransitionEntry;
  direction: "invert" | "reapply";
  op: TreeChangeOp;
};

/**
 * Why a tree inverse found its destination unable to take it at commit, under the locks: the
 * location is taken, its folder is gone, or a different removal is current.
 */
export type TreeInverseFault = TreeReversalFault | "refused";

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

/** Every folder a recorded tree change's placements name. */
export function treeChangeFolders(change: TreeChange): string[] {
  if (change.op === "settle") return [];
  const states: (LiveTreeState | BranchTreeFacts)[] = [change.before, change.after];
  return states.flatMap((state) => {
    const at = "living" in state ? (state.living ? state.at : null) : state.moved;
    return at?.folderId ? [at.folderId] : [];
  });
}

/**
 * A recorded tree change with its placements' folders as they stand now (`folderOf`): a hidden
 * folder a live one absorbed since is that live one, so comparing and writing back see one
 * identity for one place.
 */
export function withCurrentFolders(
  change: TreeChange,
  folderOf: (id: string) => string,
): TreeChange {
  if (change.op === "settle") return change;
  const place = (at: TreePlacement): TreePlacement =>
    at.folderId ? { ...at, folderId: folderOf(at.folderId) } : at;
  if (isLiveTransition(change)) {
    const live = (state: LiveTreeState): LiveTreeState =>
      state.living ? { living: true, at: place(state.at) } : state;
    return { ...change, before: live(change.before), after: live(change.after) };
  }
  const facts = (state: BranchTreeFacts): BranchTreeFacts =>
    state.moved ? { ...state, moved: place(state.moved) } : state;
  return { ...change, before: facts(change.before), after: facts(change.after) };
}

/** A tree entry's key in the effective action index; text parts key by ordinal. */
export const treeKey = (editId: string) => `${editId}:tree`;

export function sameLiveState(
  a: LiveTreeState | null | undefined,
  b: LiveTreeState | null | undefined,
): boolean {
  if (!a || !b || a.living !== b.living) return false;
  if (a.living && b.living) return samePlacement(a.at, b.at);
  if (!a.living && !b.living)
    return (
      a.removal.time === b.removal.time && a.removal.locationVersion === b.removal.locationVersion
    );
  return false;
}

const NO_BRANCH_FACTS: BranchTreeFacts = {
  row: false,
  created: false,
  moved: null,
  deleted: false,
};

/** A branch's facts in `states`: none until it has a row. */
export function branchFacts(states: TreeStates, branchId: BranchId): BranchTreeFacts {
  return states.branches.get(branchId) ?? NO_BRANCH_FACTS;
}

/** Whether `states` still hold what `transition` left: the state it can be reversed from. */
export function holdsAfter(states: TreeStates, transition: TreeTransition): boolean {
  return isLiveTransition(transition)
    ? sameLiveState(states.live, transition.after)
    : sameBranchFacts(branchFacts(states, transition.destination.branchId), transition.after);
}

/** A planned live state as a recorded one: a removal still to be made is the one it stands in for. */
export function recordedLiveState(state: PlannedLiveState): LiveTreeState {
  return state.living ? state : { living: false, removal: state.removal };
}

/** A planned step's transition as the history records it, its destination and states correlated. */
export function plannedTransition(planned: PlannedTreeInverse): TreeTransition {
  return isLiveTransition(planned)
    ? {
        destination: planned.destination,
        before: recordedLiveState(planned.before),
        after: planned.after,
      }
    : { destination: planned.destination, before: planned.before, after: planned.after };
}

/** `states` once `planned` ran; a removal it makes names the step until it runs. */
export function advanceStates(states: TreeStates, planned: PlannedTreeInverse): TreeStates {
  if (isLiveTransition(planned))
    return {
      ...states,
      live: planned.after.living
        ? planned.after
        : { living: false, removal: planned.after.removal, madeBy: planned.step },
    };
  const branches = new Map(states.branches);
  branches.set(planned.destination.branchId, planned.after);
  return { ...states, branches };
}

/**
 * The latest row that applied or reversed `entry` and was not itself rolled back: the entry, a
 * row naming it, or a row reversing such a row (an undo of a revert reapplies the entry; a
 * rollback of an undo leaves it as the undo found it). Its `after` is what the destination
 * holds while nothing else changed it; `stands` says whether the entry's effect is in place.
 * `tree` is ordered by id.
 */
export function latestTransition<
  T extends Pick<StoredTreeEntry, "id" | "editId" | "targets" | "tree">,
>(
  entry: T & { tree: TreeTransitionChange },
  tree: readonly T[],
  rolledBack: ReadonlySet<string>,
): { row: T & { tree: TreeTransitionChange }; stands: boolean } {
  // Each row in the chain, with whether it left the entry standing.
  const stood = new Map<string, boolean>([[entry.editId, true]]);
  let latest: { row: T & { tree: TreeTransitionChange }; stands: boolean } = {
    row: entry,
    stands: true,
  };
  for (const row of tree) {
    if (row.id <= entry.id || !isTransitionEntry(row) || rolledBack.has(treeKey(row.editId)))
      continue;
    for (const target of row.targets) {
      const prior = stood.get(target.editId);
      if (prior === undefined) continue;
      const stands = target.direction === "reapply" ? prior : !prior;
      stood.set(row.editId, stands);
      latest = { row, stands };
    }
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
    if (
      row.id > entry.id &&
      row.tree.op === "settle" &&
      row.tree.settles.editIds.includes(entry.editId)
    )
      if (!settled || row.id > settled.id) settled = { id: row.id, as: row.tree.settles.as };
  return settled?.as ?? null;
}

/**
 * Why `change` is not a row the history may hold, or null. The history writer is the one
 * boundary that checks it: readers trust the rows. A transition joins states of its own
 * destination's kind with endpoints its op can make; a settlement names what it ended.
 */
export function treeChangeFault(change: TreeChange): string | null {
  if (change.op === "settle")
    return change.targets.length === 0 && change.settles.editIds.length > 0
      ? null
      : "A settlement names the entries it ended and reverses none";
  const live = change.destination.kind === "live";
  const shaped = (state: unknown) =>
    typeof state === "object" && state !== null && (live ? "living" in state : "row" in state);
  if (!shaped(change.before) || !shaped(change.after))
    return `A ${change.destination.kind} transition joins ${change.destination.kind} states`;
  if (isLiveTransition(change)) {
    const { before, after } = change;
    const fits =
      change.op === "move"
        ? before.living && after.living && !samePlacement(before.at, after.at)
        : change.op === "delete"
          ? before.living && !after.living
          : !before.living && after.living;
    return fits ? null : `A live ${change.op} can't join these states`;
  }
  const { before, after } = change;
  const fits =
    change.op === "move"
      ? !sameBranchFacts(before, after)
      : change.op === "delete"
        ? !before.deleted && after.deleted
        : before.deleted && !after.deleted;
  return fits ? null : `A drafted ${change.op} can't join these facts`;
}

const INVERSE_OP = { move: "move", delete: "restore", restore: "delete" } as const;

/**
 * The transition that inverts (or reapplies) `entry`, from the state its latest transition left.
 * Null when that state no longer holds: the entry was built on.
 */
export function planTreeInverse(
  entry: TransitionEntry,
  direction: "invert" | "reapply",
  latest: TransitionEntry,
  states: TreeStates,
  step: number,
): PlannedTreeInverse | null {
  if (!holdsAfter(states, latest.tree)) return null;
  const op = direction === "invert" ? INVERSE_OP[entry.tree.op] : entry.tree.op;
  const common = { step, entry, direction, op };
  const { tree } = entry;
  // The state the destination holds, which `holdsAfter` matched: a removal still to be made
  // keeps naming the step that makes it.
  if (isLiveTransition(tree))
    return states.live
      ? {
          ...common,
          destination: tree.destination,
          before: states.live,
          after: direction === "invert" ? tree.before : tree.after,
        }
      : null;
  return {
    ...common,
    destination: tree.destination,
    before: branchFacts(states, tree.destination.branchId),
    after: direction === "invert" ? tree.before : tree.after,
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

/** A commit-time fault in the model's words; the app words the card's from the typed cause. */
export function treeFaultReason(fault: TreeInverseFault): string {
  switch (fault) {
    case "folder_blocked":
      return "a document blocks its folder path";
    case "folder_missing":
      return "its folder is gone";
    case "superseded":
      return "it was deleted after this change";
    case "refused":
      return "it can't be restored here";
  }
}

/** Why a tree entry can't be reversed as it stands, for the model and the card. */
export function treeChangedCause(
  states: TreeStates,
  destination: TreeChangeDestination,
): "deleted_since" | "moved_since" | "changed_since" {
  if (destination.kind === "live" && states.live)
    return states.live.living ? "moved_since" : "deleted_since";
  return "changed_since";
}
