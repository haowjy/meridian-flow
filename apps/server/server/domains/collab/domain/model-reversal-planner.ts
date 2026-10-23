/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import {
  type DocumentEditResult,
  type InverseSelection,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
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
  const inspections = new Map<Y.Doc, Inspection>();
  inspections.set(document.live, inspectionContext(liveIndex, actions));
  for (const documentDraft of document.drafts.values()) {
    const index = liveIndex.forView(documentDraft.doc);
    inspections.set(documentDraft.doc, inspectionContext(index, actions));
  }
  const inspect = (current = view) => {
    const inspection = inspections.get(current);
    if (!inspection) throw new Error("Missing immutable-view inspection");
    return inspection;
  };
  const version = (destination: InverseDestination) => {
    const draftId = draftIdOf(destination);
    return destination.kind === "draft"
      ? `draft (${draftId ? (document.drafts.get(draftId)?.name ?? "unavailable") : "unavailable"})`
      : "live";
  };
  function refusal(
    part: StoredInversePart,
    handle: string,
    direction: "undo" | "redo",
    inspection: Inspection,
  ): Exclude<DocumentEditResult, { status: "success" }> | null {
    const follow = `Use revert on ${document.uri}, or read it and make a new replace.`;
    const discarded = {
      status: `cant_${direction}_discarded` as const,
      message: `The user discarded ${handle}; it is already gone. ${follow}`,
    };
    const destination = document.destinationOf(part.origin);
    if (destination.frozen)
      return {
        status: "work_archived",
        message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
      };
    if (destination.kind === "live" && destination.removed)
      return {
        status: "document_not_found",
        message: "File not found. Read the project to find the right path.",
      };
    if (destination.kind === "draft" && destination.state === "gone") return discarded;
    const state = inspection.states([part])[0];
    if (state.state !== (direction === "undo" ? "active" : "undone")) {
      if (part.disposition === "discarded") return discarded;
      return {
        status: `cant_${direction}_changed`,
        message: `Can't ${direction} ${handle}: none of that edit remains unchanged. Read ${document.uri} for current text.`,
      };
    }
    return null;
  }
  function changedReason(part: StoredInversePart, inspection: Inspection) {
    const state = inspection.states([part])[0];
    return state.reasons.includes("inaccessible ancestor")
      ? "paragraph replaced or removed"
      : state.state === "undone"
        ? "already removed"
        : "edited since";
  }

  function textSelection(
    entry: Entry,
    direction: "undo" | "redo",
    inspection: Inspection,
    inverseParts: readonly StoredInversePart[] = [],
  ) {
    const selection: InverseSelection[] = [];
    const partial: string[] = [];
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
      const refused = refusal(candidate, entry.handle, direction, inspection);
      if (!refused)
        selection.push({ part: original, direction: direction === "undo" ? "invert" : "reapply" });
      else if (refused.status === `cant_${direction}_changed`)
        partial.push(
          `${entry.handle} part ${original.ordinal + 1}: ${changedReason(original, inspection)}`,
        );
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
      classify?: boolean;
    } = {},
  ) {
    const destinationParts = direction === "redo" ? (options.inverseParts ?? []) : entry.parts;
    const destinations = new Set(
      destinationParts.map((part) => document.destinationOf(part.origin)),
    );
    if (destinations.size !== 1) throw new Error("One model edit spans multiple versions");
    const [destination] = destinations;
    if (!destination) throw new Error("One model edit has no destination");
    if (options.classify === false && destination.kind === "draft" && destination.state === "gone")
      return {
        status: `cant_${direction === "redo" ? "redo" : "undo"}_discarded` as const,
        message: `The user discarded ${entry.handle}; it is already gone.`,
      };
    if (destination.frozen)
      return {
        status: "work_archived" as const,
        message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
      };
    if (destination.kind === "live" && (options.liveRemoved ?? destination.removed))
      return {
        status: "document_not_found" as const,
        message: "File not found. Read the project to find the right path.",
      };
    const actionKind =
      options.actionKind ??
      (direction === "undo" &&
      entry.parts.some((part) => part.origin.kind === "pending" && part.disposition === "applied")
        ? "revert"
        : direction);
    if (options.classify === false)
      return {
        destination,
        actionKind,
        selection: entry.parts.map(
          (part): InverseSelection => ({
            part,
            direction: direction === "redo" ? ("reapply" as const) : ("invert" as const),
          }),
        ),
        omissions: [],
      };
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
    if ("refusal" in selected && selected.refusal) return selected.refusal;
    return {
      destination,
      actionKind,
      selection: selected.selection,
      omissions: "partial" in selected ? selected.partial : selected.skipped,
    };
  }
  function poppableForTurn(turn: TurnInverseQuery, rollback: boolean) {
    const poppable = new Set<string>();
    if (rollback) return poppable;
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
    return poppable;
  }
  function treePlan(
    entry: Entry & { tree: TransitionEntry },
    direction: "undo" | "redo" | "revert",
    tree: readonly StoredTreeEntry[],
    states: InverseDocument["treeStates"],
    rolledBack: ReadonlySet<string>,
    step: () => number,
  ): PlannedTreeInverse | Exclude<DocumentEditResult, { status: "success" }> {
    const verb = direction === "revert" ? "undo" : direction;
    const follow = "Check where it is with `ls`, then make a new move or delete if needed.";
    const row = entry.tree;
    const destination = row.tree.destination;
    const resolvedDestination =
      destination.kind === "draft"
        ? document.destinationForBranch(destination.branchId)
        : document.destinationOf({ kind: "live", seq: 0 });
    if (resolvedDestination.frozen)
      return {
        status: "work_archived",
        message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
      };
    const settled = settlementOf(row, tree);
    if (settled === "applied")
      return {
        status: `cant_${verb}_applied`,
        message: `The user applied ${entry.handle} to the manuscript. ${follow}`,
      };
    if (settled === "discarded")
      return {
        status: `cant_${verb}_discarded`,
        message: `The user discarded ${entry.handle}; it is already gone. ${follow}`,
      };
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
    return {
      status: `cant_${verb}_changed`,
      message: `${entry.handle} can't be ${verb === "undo" ? "undone" : "redone"}: the document was ${treeChangedCause(states, destination).replace("_", " ")} you ${verb === "undo" ? "made" : "undid"} it. ${follow}`,
    };
  }
  function revertSelection(entry: Entry, inspection = inspect()) {
    const skipped: string[] = [];
    const selection: InverseSelection[] = [];
    const states = inspection.states(entry.parts);
    for (const [i, part] of entry.parts.entries()) {
      const state = states[i];
      const originDestination = document.destinationOf(part.origin);
      const kernelReason =
        state?.state === "undone"
          ? "already removed"
          : state?.reasons.includes("inaccessible ancestor")
            ? "paragraph replaced or removed"
            : state?.state !== "active"
              ? "edited since"
              : null;
      const reason = originDestination.frozen
        ? "draft archived"
        : originDestination.kind === "live" && originDestination.removed
          ? "document deleted"
          : originDestination.kind === "draft" && originDestination.state === "gone"
            ? "discarded"
            : inspection.rolledBack(part)
              ? "rolled back"
              : kernelReason && part.disposition === "discarded"
                ? "discarded"
                : kernelReason;
      if (reason) skipped.push(`part ${part.ordinal + 1}: ${reason}`);
      else selection.push({ part, direction: "invert" });
    }
    return { selection, skipped };
  }
  return {
    view,
    own,
    inspect,
    textPlan,
    poppableForTurn,
    treePlan,
    version,
    queryDestination,
    draftIdOf,
  };
}
