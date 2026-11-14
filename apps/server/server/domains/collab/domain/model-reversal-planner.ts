/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import {
  type InverseSelection,
  type PartClassification,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
import type { TurnInverseSkipCause } from "@meridian/contracts/protocol";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import { settledCause } from "./draft-disposition.js";
import type { InverseDestination } from "./inverse-draft-destination.js";
import {
  type Entry,
  entries,
  type Inspection,
  inspectionActions,
  inspectionContext,
} from "./model-inverse-selection.js";
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
  const own = entries(document.history, query.threadId);
  const actions = inspectionActions(document.history, own);
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
  type TextFailure =
    | "draft_archived"
    | "document_deleted"
    | "applied"
    | "partly_applied"
    | "discarded"
    | "changed";
  // A closed draft keeps its apply record: a part is in the manuscript if it was applied,
  // and gone otherwise.
  const closedPartCause = (part: StoredInversePart) =>
    settledCause(part.disposition) ?? "discarded";
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
    if (destination.kind === "draft" && destination.state === "gone") return closedPartCause(part);
    const state = inspection.states([part])[0];
    if (state.state !== (direction === "undo" ? "active" : "undone")) {
      return settledCause(part.disposition) ?? "changed";
    }
    return null;
  }
  const inverseOf = (original: StoredInversePart, inverseParts: readonly StoredInversePart[]) =>
    inverseParts.find((part) =>
      part.targets.some((target) =>
        target.ordinal === original.ordinal ? target.editId === original.editId : false,
      ),
    );
  // What the kernel found, as a cause: a part the kernel cannot reach reads from the first
  // reason it gives. The writer's apply or discard outranks this (`settledCause`).
  const kernelCause = (kernel: PartClassification | null | undefined) =>
    kernel?.reasons.includes("inaccessible ancestor")
      ? ("paragraph_removed" as const)
      : kernel?.state === "undone"
        ? ("already_removed" as const)
        : ("edited_since" as const);
  /** The per-turn skip cause, in the turn protocol's words, for a part found `kernel` after `direction`. */
  function turnSkipCause(
    part: StoredInversePart,
    direction: "undo" | "redo",
    inverseParts: readonly StoredInversePart[],
    kernel: PartClassification | null,
  ): TurnInverseSkipCause {
    const settledBy = direction === "redo" ? (inverseOf(part, inverseParts) ?? part) : part;
    const cause = settledCause(settledBy.disposition) ?? kernelCause(kernel);
    return cause === "already_removed" ? "already_undone" : cause;
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
      const inverse = direction === "redo" ? inverseOf(original, inverseParts) : undefined;
      if (direction === "redo" && !inverse)
        throw new Error("Undo action has no inverse for its target");
      const candidate = inverse
        ? { ...original, origin: inverse.origin, disposition: inverse.disposition }
        : original;
      const refused = refusal(candidate, direction, inspection);
      if (!refused)
        selection.push({ part: original, direction: direction === "undo" ? "invert" : "reapply" });
      else if (refused === "changed")
        partial.push({
          ordinal: original.ordinal,
          cause: kernelCause(inspection.states([original])[0]),
        });
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
    if (destination.kind === "draft" && destination.state === "gone") {
      const causes = new Set(entry.parts.map(closedPartCause));
      return {
        failure:
          causes.size > 1
            ? ("partly_applied" as const)
            : causes.has("applied")
              ? ("applied" as const)
              : ("discarded" as const),
      };
    }
    if (destination.frozen) return { failure: "draft_archived" as const };
    if (destination.kind === "live" && destination.removed)
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
    inverseParts: readonly StoredInversePart[] = [],
  ) {
    const destinationParts = direction === "redo" ? inverseParts : entry.parts;
    const destinations = new Set(
      destinationParts.map((part) => document.destinationOf(part.origin)),
    );
    if (destinations.size !== 1) throw new Error("One edit spans multiple versions");
    const [destination] = destinations;
    if (!destination) throw new Error("One edit has no destination");
    const every = (cause: TurnInverseSkipCause) => ({ causes: entry.parts.map(() => cause) });
    if (destination.frozen) return every("draft_archived");
    if (destination.kind === "draft" && destination.state === "gone")
      return {
        causes: entry.parts.map((part) =>
          closedPartCause(direction === "redo" ? (inverseOf(part, inverseParts) ?? part) : part),
        ),
      };
    if (destination.kind === "live" && destination.removed)
      return every(
        document.removal?.reason === "discarded" ? "document_discarded" : "document_deleted",
      );
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
      const belongsToTurn = entry.parts.some(
        (part) => part.threadId === turn.threadId && part.turnId === turn.turnId,
      );
      const appliedText = entry.parts.some((part) => part.disposition === "applied");
      if (!belongsToTurn || appliedText) break;
      poppable.add(entry.id);
    }
    poppableByTurn.set(turnKey, poppable);
    return poppable;
  }
  function revertSelection(entry: Entry, inspection = inspect()) {
    const skipped: TextOmission[] = [];
    const selection: InverseSelection[] = [];
    const states = inspection.states(entry.parts);
    for (const [i, part] of entry.parts.entries()) {
      const state = states[i];
      const originDestination = document.destinationOf(part.origin);
      const reason = originDestination.frozen
        ? "draft_archived"
        : originDestination.kind === "draft" && originDestination.state === "gone"
          ? "discarded"
          : inspection.rolledBack(part)
            ? "rolled_back"
            : state?.state === "active"
              ? null
              : part.disposition === "discarded"
                ? "discarded"
                : kernelCause(state);
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
    turnSkipCause,
    version,
    queryDestination,
    draftIdOf,
  };
}
