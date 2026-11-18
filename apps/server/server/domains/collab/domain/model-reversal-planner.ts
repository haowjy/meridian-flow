/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import {
  type InversePart,
  type PartClassification,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
import type { TurnInverseSkipCause } from "@meridian/contracts/protocol";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { settledCause } from "./draft-disposition.js";
import { partKey as key } from "./inverse-actions.js";
import type { InverseDestination } from "./inverse-draft-destination.js";
import { planInverseOffThread } from "./inverse-worker.js";
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
  const compute = async (
    destination: InverseDestination,
    selection: readonly InversePart[],
    actionId: string,
    { preview = false }: { preview?: boolean } = {},
  ) => {
    if (destination.kind === "draft" && destination.state === "gone")
      throw new Error("A gone destination cannot be selected");
    if (preview) {
      const index = destination.kind === "live" ? liveIndex : liveIndex.forView(destination.view);
      return index.preview(selection, { actionId, allocateClient: allocateDocumentClient });
    }
    return planInverseOffThread({
      live: Y.encodeStateAsUpdate(document.live),
      view: destination.kind === "live" ? null : Y.encodeStateAsUpdate(destination.view),
      history: document.history,
      selection,
      actionId,
    });
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
      | "discarded";
  };
  /**
   * A part an Undo took (the writer's card, the writer's revert, or the model's own undo) is done
   * with, whatever the kernel finds it could still restore: an Undo is never reversed, and a
   * later inverse can leave the part's text restorable again.
   */
  const takenBy = (part: StoredInversePart, inspection: Inspection = inspect()) =>
    inspection.actions.byPart.get(key(part));
  const taken = (part: StoredInversePart, inspection?: Inspection) =>
    takenBy(part, inspection) !== undefined;
  function refusal(part: StoredInversePart, inspection: Inspection): TextFailure | null {
    const destination = document.destinationOf(part.origin);
    if (destination.closed) return "draft_archived";
    if (destination.kind === "draft" && destination.state === "gone") return closedPartCause(part);
    if (taken(part, inspection)) return "changed";
    const state = inspection.states([part])[0];
    if (state.state !== "active") {
      return settledCause(part.disposition) ?? "changed";
    }
    return null;
  }
  // Why a part is not reversible, as a cause: one an Undo took reads as removed, else the
  // kernel's first reason. The writer's apply or discard outranks this (`settledCause`).
  const kernelCause = (
    part: StoredInversePart,
    kernel: PartClassification | null | undefined,
    inspection: Inspection = inspect(),
  ) =>
    taken(part, inspection)
      ? ("already_removed" as const)
      : kernel?.reasons.includes("inaccessible ancestor")
        ? ("paragraph_removed" as const)
        : ("edited_since" as const);
  /** The per-turn skip cause, in the turn protocol's words, for a part found `kernel`. */
  function turnSkipCause(
    part: StoredInversePart,
    kernel: PartClassification | null,
  ): TurnInverseSkipCause {
    const cause = settledCause(part.disposition) ?? kernelCause(part, kernel);
    return cause === "already_removed" ? "already_undone" : cause;
  }

  function textSelection(entry: Entry, inspection: Inspection) {
    const selection: InversePart[] = [];
    const partial: TextOmission[] = [];
    for (const original of [...entry.parts].sort((a, b) => b.id - a.id)) {
      const refused = refusal(original, inspection);
      if (!refused) selection.push(original);
      else if (refused === "changed")
        partial.push({
          ordinal: original.ordinal,
          cause: kernelCause(original, inspection.states([original])[0], inspection),
        });
      else return { selection, partial, refusal: refused };
    }
    return { selection, partial, refusal: null };
  }
  function textPlan(
    entry: Entry,
    direction: "undo" | "revert",
    inspectAt: (destination: InverseDestination) => Inspection,
  ) {
    const destinations = new Set(entry.parts.map((part) => document.destinationOf(part.origin)));
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
    if (destination.closed) return { failure: "draft_archived" as const };
    if (destination.kind === "live" && destination.removed)
      return { failure: "document_deleted" as const };
    const actionKind =
      direction === "undo" &&
      entry.parts.some((part) => part.origin.kind === "pending" && part.disposition === "applied")
        ? "revert"
        : direction;
    const inspection = inspectAt(destination);
    inspection.states(entry.parts);
    const selected =
      actionKind === "revert"
        ? revertSelection(entry, inspection)
        : textSelection(entry, inspection);
    if ("refusal" in selected && selected.refusal) return { failure: selected.refusal };
    return {
      destination,
      actionKind,
      selection: selected.selection,
      omissions: "partial" in selected ? selected.partial : selected.skipped,
    };
  }
  function turnTextPlan(entry: Entry, turn: TurnInverseQuery) {
    const destinations = new Set(entry.parts.map((part) => document.destinationOf(part.origin)));
    if (destinations.size !== 1) throw new Error("One edit spans multiple versions");
    const [destination] = destinations;
    if (!destination) throw new Error("One edit has no destination");
    const every = (cause: TurnInverseSkipCause) => ({ causes: entry.parts.map(() => cause) });
    if (destination.closed) return every("returned");
    if (destination.kind === "draft" && destination.state === "gone")
      return { causes: entry.parts.map(closedPartCause) };
    if (destination.kind === "live" && destination.removed) return every("document_deleted");
    const actionKind = poppableForTurn(turn).has(entry.id)
      ? ("undo" as const)
      : ("revert" as const);
    // A part of an open draft that no change waits on and that was not applied was discarded:
    // its text is not there for an Undo to take out.
    const settled = (part: StoredInversePart) =>
      destination.kind === "draft" && !part.waiting && part.disposition !== "applied";
    return {
      destination,
      actionKind,
      selection: entry.parts.filter((part) => !settled(part)),
      discarded: entry.parts.filter(settled),
    };
  }
  function poppableForTurn(turn: TurnInverseQuery) {
    const poppable = new Set<string>();
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
    const selection: InversePart[] = [];
    const states = inspection.states(entry.parts);
    for (const [i, part] of entry.parts.entries()) {
      const state = states[i];
      const originDestination = document.destinationOf(part.origin);
      const reason = originDestination.closed
        ? "draft_archived"
        : originDestination.kind === "draft" && originDestination.state === "gone"
          ? "discarded"
          : state?.state === "active" && !taken(part, inspection)
            ? null
            : part.disposition === "discarded"
              ? "discarded"
              : kernelCause(part, state, inspection);
      if (reason) skipped.push({ ordinal: part.ordinal, cause: reason });
      else selection.push(part);
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
    takenBy,
    version,
    queryDestination,
    draftIdOf,
  };
}
