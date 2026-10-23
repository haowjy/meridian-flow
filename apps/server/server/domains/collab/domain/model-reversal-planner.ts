/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import { type InverseSelection, prepareEditRoots } from "@meridian/agent-edit/integration";
import type { TurnInverseSkipCause } from "@meridian/contracts/protocol";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { InverseDestination } from "./inverse-draft-destination.js";
import {
  type Entry,
  entries,
  type Inspection,
  inspectionActions,
  inspectionContext,
} from "./model-inverse-selection.js";
import {
  latestTransition,
  type PlannedTreeInverse,
  planTreeInverse,
  type StoredTreeEntry,
  settlementOf,
  type TransitionEntry,
  treeChangedCause,
} from "./tree-inverse.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
} from "./turn-inverse-service.js";

export type ModelInverseQuery = TurnInverseQuery & {
  model: true;
  draftId: string | null;
};

/** One immutable capture's reversal policy. A retry creates a new planner from a new capture. */
export function createCapturedReversalPlanner(document: InverseDocument, query: TurnInverseQuery) {
  const liveIndex = prepareEditRoots(document.live, document.history);
  const queryDestination = query.draftId
    ? document.destinationOf({ kind: "pending", draftId: query.draftId, rowId: 0 })
    : document.destinationOf({ kind: "live", seq: 0 });
  const draftIdOf = (destination: InverseDestination): string | null =>
    destination.kind === "draft" && destination.state === "active" ? destination.draftId : null;
  const view =
    queryDestination.kind === "draft" && queryDestination.state === "gone"
      ? document.live
      : queryDestination.view;
  const own = entries(document, query.threadId);
  const actions = inspectionActions(document.history, document.tree, own);
  const poppableByTurn = new Map<string, Set<string>>();
  const inspections = new Map<Y.Doc, Inspection>();
  inspections.set(document.live, inspectionContext(liveIndex, actions));
  const inspect = (current = view) => {
    let inspection = inspections.get(current);
    if (!inspection) {
      inspection = inspectionContext(liveIndex.forView(current), actions);
      inspections.set(current, inspection);
    }
    return inspection;
  };
  const compute = (
    destination: InverseDestination,
    selection: readonly InverseSelection[],
    actionId: string,
  ) => {
    if (destination.kind === "draft" && destination.state === "gone")
      throw new Error("A gone destination cannot be selected");
    const index = destination.kind === "live" ? liveIndex : liveIndex.forView(destination.view);
    return index.compute(selection, { actionId, allocateClient: allocateDocumentClient });
  };
  const version = (destination: InverseDestination) => {
    const draftId = draftIdOf(destination);
    return destination.kind === "draft"
      ? `draft (${draftId ? (document.drafts.get(draftId)?.name ?? "unavailable") : "unavailable"})`
      : "live";
  };
  type TextFailure = "draft_archived" | "document_deleted" | "discarded" | "changed";
  type TextOmission = {
    ordinal: number;
    cause:
      | "paragraph_removed"
      | "already_removed"
      | "edited_since"
      | "draft_archived"
      | "discarded"
      | "rolled_back";
  };
  function refusal(
    part: StoredInversePart,
    direction: "undo" | "redo",
    inspection: Inspection,
  ): TextFailure | null {
    const destination = document.destinationOf(part.origin);
    if (destination.frozen) return "draft_archived";
    if (destination.kind === "draft" && destination.state === "gone") return "discarded";
    const state = inspection.states([part])[0];
    if (state.state !== (direction === "undo" ? "active" : "undone")) {
      if (part.disposition === "discarded") return "discarded";
      return "changed";
    }
    return null;
  }
  function changedReason(part: StoredInversePart, inspection: Inspection): TextOmission["cause"] {
    const state = inspection.states([part])[0];
    return state.reasons.includes("inaccessible ancestor")
      ? "paragraph_removed"
      : state.state === "undone"
        ? "already_removed"
        : "edited_since";
  }

  function textSelection(
    entry: Entry,
    direction: "undo" | "redo",
    inspection: Inspection,
    inverseParts: readonly StoredInversePart[] = [],
  ) {
    const selection: InverseSelection[] = [];
    const partial: TextOmission[] = [];
    for (const original of direction === "undo"
      ? [...entry.parts].sort((a, b) => b.id - a.id)
      : entry.parts) {
      const inverse =
        direction === "redo"
          ? inverseParts.find((part) =>
              part.targets.some((target) =>
                target.ordinal === original.ordinal ? target.editId === original.editId : false,
              ),
            )
          : undefined;
      if (direction === "redo" && !inverse)
        throw new Error("Undo action has no inverse for its target");
      const candidate = inverse
        ? { ...original, origin: inverse.origin, disposition: inverse.disposition }
        : original;
      const refused = refusal(candidate, direction, inspection);
      if (!refused)
        selection.push({ part: original, direction: direction === "undo" ? "invert" : "reapply" });
      else if (refused === "changed")
        partial.push({ ordinal: original.ordinal, cause: changedReason(original, inspection) });
      else return { selection, partial, refusal: refused };
    }
    return { selection, partial, refusal: null };
  }
  function textPlan(
    entry: Entry,
    direction: "undo" | "redo" | "revert",
    inspectAt: (destination: InverseDestination) => Inspection,
    options: {
      inverseParts?: readonly StoredInversePart[];
      liveRemoved?: boolean;
      actionKind?: "undo" | "redo" | "revert" | "rollback";
    } = {},
  ) {
    const destinationParts = direction === "redo" ? (options.inverseParts ?? []) : entry.parts;
    const destinations = new Set(
      destinationParts.map((part) => document.destinationOf(part.origin)),
    );
    if (destinations.size !== 1) throw new Error("One model edit spans multiple versions");
    const [destination] = destinations;
    if (!destination) throw new Error("One model edit has no destination");
    if (destination.kind === "draft" && destination.state === "gone")
      return { failure: "discarded" as const };
    if (destination.frozen) return { failure: "draft_archived" as const };
    if (destination.kind === "live" && (options.liveRemoved ?? destination.removed))
      return { failure: "document_deleted" as const };
    const actionKind =
      options.actionKind ??
      (direction === "undo" &&
      entry.parts.some((part) => part.origin.kind === "pending" && part.disposition === "applied")
        ? "revert"
        : direction);
    const inspection = inspectAt(destination);
    inspection.states(entry.parts);
    const selected =
      actionKind === "revert"
        ? revertSelection(entry, inspection)
        : textSelection(
            entry,
            direction === "revert" ? "undo" : direction,
            inspection,
            options.inverseParts,
          );
    if ("refusal" in selected && selected.refusal) return { failure: selected.refusal };
    return {
      destination,
      actionKind,
      selection: selected.selection,
      omissions: "partial" in selected ? selected.partial : selected.skipped,
    };
  }
  function turnTextPlan(
    entry: Entry,
    direction: "undo" | "redo",
    kind: "undo" | "redo" | "rollback",
    turn: TurnInverseQuery,
    liveRemoved: boolean,
    inverseParts: readonly StoredInversePart[] = [],
  ) {
    const destinationParts = direction === "redo" ? inverseParts : entry.parts;
    const destinations = new Set(
      destinationParts.map((part) => document.destinationOf(part.origin)),
    );
    if (destinations.size !== 1) throw new Error("One edit spans multiple versions");
    const [destination] = destinations;
    if (!destination) throw new Error("One edit has no destination");
    if (destination.frozen) return { cause: "draft_archived" as const };
    if (destination.kind === "draft" && destination.state === "gone")
      return { cause: "discarded" as const };
    if (destination.kind === "live" && liveRemoved)
      return {
        cause:
          document.removal?.reason === "discarded"
            ? ("document_discarded" as const)
            : ("document_deleted" as const),
      };
    const actionKind =
      kind === "rollback"
        ? "rollback"
        : direction === "redo"
          ? "redo"
          : poppableForTurn(turn, false).has(entry.id)
            ? "undo"
            : "revert";
    return {
      destination,
      actionKind,
      selection: entry.parts.map(
        (part): InverseSelection => ({
          part,
          direction: direction === "redo" ? "reapply" : "invert",
        }),
      ),
    };
  }
  function poppableForTurn(turn: TurnInverseQuery, rollback: boolean) {
    const poppable = new Set<string>();
    if (rollback) return poppable;
    const turnKey = `${turn.threadId}:${turn.turnId ?? ""}`;
    const cached = poppableByTurn.get(turnKey);
    if (cached) return cached;
    for (const entry of actions.stack) {
      const belongsToTurn =
        entry.parts.some(
          (part) => part.threadId === turn.threadId && part.turnId === turn.turnId,
        ) ||
        (entry.tree
          ? entry.tree.threadId === turn.threadId && entry.tree.turnId === turn.turnId
          : false);
      const appliedText = entry.parts.some((part) => part.disposition === "applied");
      const settledTree = entry.tree ? settlementOf(entry.tree, document.tree) : null;
      if (!belongsToTurn || appliedText || settledTree) break;
      poppable.add(entry.id);
    }
    poppableByTurn.set(turnKey, poppable);
    return poppable;
  }
  function treePlan(
    entry: Entry & { tree: TransitionEntry },
    direction: "undo" | "redo" | "revert",
    tree: readonly StoredTreeEntry[],
    states: InverseDocument["treeStates"],
    rolledBack: ReadonlySet<string>,
    step: () => number,
  ): PlannedTreeInverse | { cause: TurnInverseSkipCause } {
    const row = entry.tree;
    const destination = row.tree.destination;
    const resolvedDestination =
      destination.kind === "draft"
        ? document.destinationForBranch(destination.branchId)
        : document.destinationOf({ kind: "live", seq: 0 });
    if (resolvedDestination.frozen) return { cause: "draft_archived" };
    const settled = settlementOf(row, tree);
    if (settled === "applied") return { cause: "applied" };
    if (settled === "discarded") return { cause: "discarded" };
    const latest = latestTransition(row, tree, rolledBack);
    const planned =
      latest.stands === (direction !== "redo")
        ? planTreeInverse(
            row,
            direction === "redo" ? "reapply" : "invert",
            latest.row,
            states,
            step(),
          )
        : null;
    if (planned) return planned;
    if (latest.stands !== (direction !== "redo"))
      return { cause: direction === "redo" ? "already_redone" : "already_undone" };
    return { cause: treeChangedCause(states, destination) };
  }
  function revertSelection(entry: Entry, inspection = inspect()) {
    const skipped: TextOmission[] = [];
    const selection: InverseSelection[] = [];
    const states = inspection.states(entry.parts);
    for (const [i, part] of entry.parts.entries()) {
      const state = states[i];
      const originDestination = document.destinationOf(part.origin);
      const kernelReason =
        state?.state === "undone"
          ? "already_removed"
          : state?.reasons.includes("inaccessible ancestor")
            ? "paragraph_removed"
            : state?.state !== "active"
              ? "edited_since"
              : null;
      const reason = originDestination.frozen
        ? "draft_archived"
        : originDestination.kind === "draft" && originDestination.state === "gone"
          ? "discarded"
          : inspection.rolledBack(part)
            ? "rolled_back"
            : kernelReason && part.disposition === "discarded"
              ? "discarded"
              : kernelReason;
      if (reason) skipped.push({ ordinal: part.ordinal, cause: reason });
      else selection.push({ part, direction: "invert" });
    }
    return { selection, skipped };
  }
  return {
    view,
    own,
    inspect,
    compute,
    textPlan,
    turnTextPlan,
    treePlan,
    version,
    queryDestination,
    draftIdOf,
  };
}
