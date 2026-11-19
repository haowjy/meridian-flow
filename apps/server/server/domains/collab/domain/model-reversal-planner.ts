/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import { REVIEW_BASE_FRAGMENT, readBlocks } from "@meridian/agent-edit/diff";
import {
  type InversePart,
  type PartClassification,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
import { allocateDocumentClient, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { draftSchema, isPending, takeOutStanding } from "./draft-changes.js";
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
  // An open draft's parts are read from its text, never through the Yjs lineage: the only
  // lineage inspected is Live's.
  const own = entries(document.history, query.threadId);
  const actions = inspectionActions(document.history, own);
  const poppableByTurn = new Map<string, Set<string>>();
  const liveInspection = inspectionContext(liveIndex, actions);
  const inspect = () => liveInspection;
  const compute = async (
    destination: InverseDestination,
    selection: readonly InversePart[],
    actionId: string,
    { preview = false }: { preview?: boolean } = {},
  ) => {
    if (destination.kind === "draft")
      throw new Error("A draft's parts are taken out as content, not computed on the lineage");
    if (preview)
      return liveIndex.preview(selection, { actionId, allocateClient: allocateDocumentClient });
    return planInverseOffThread({
      live: Y.encodeStateAsUpdate(document.live),
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
  /** A part of an open draft is judged by its text: one of its changes stands and sits in a pending change. */
  const inOpenDraft = (part: StoredInversePart) => {
    const destination = document.destinationOf(part.origin);
    return destination.kind === "draft" && destination.state === "active";
  };
  /**
   * The text of each open draft after the steps planned so far, so a later step of one command is
   * judged on what the earlier ones leave, as its commit will.
   */
  const planned = new Map<string, readonly PMNode[]>();
  const baseOf = (draftId: string) => {
    const doc = document.drafts.get(draftId)?.doc;
    return doc ? readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), draftSchema) : [];
  };
  const standsInDraft = (part: StoredInversePart) => {
    const text = part.origin.kind === "pending" ? planned.get(part.origin.draftId) : undefined;
    return text && part.origin.kind === "pending"
      ? takeOutStanding(text, baseOf(part.origin.draftId), [part]).taken.length > 0
      : (part.changes?.some((change) => change.state === "stands" && isPending(change)) ?? false);
  };
  /** Records that `parts` were chosen to be taken out of their open draft. */
  const planTakeOut = (draftId: string, parts: readonly StoredInversePart[]) => {
    const doc = document.drafts.get(draftId)?.doc;
    if (!doc) return;
    const text =
      planned.get(draftId) ??
      readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema);
    planned.set(draftId, takeOutStanding(text, baseOf(draftId), parts).text);
  };
  /** A part whose text no longer reads as the edit wrote it. */
  const changed = (part: StoredInversePart) =>
    inOpenDraft(part) ? !standsInDraft(part) : inspect().states([part])[0].state === "changed";
  /** Whether a part can still be taken out where it landed. */
  const available = (part: StoredInversePart, inspection: Inspection) =>
    inOpenDraft(part)
      ? standsInDraft(part)
      : !taken(part, inspection) && inspection.states([part])[0].state === "active";
  function refusal(part: StoredInversePart, inspection: Inspection): TextFailure | null {
    const destination = document.destinationOf(part.origin);
    if (destination.closed) return "draft_archived";
    if (destination.kind === "draft" && destination.state === "gone") return closedPartCause(part);
    if (available(part, inspection)) return null;
    return settledCause(part.disposition) ?? "changed";
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
  /** Why a part is not available: an open draft's text no longer holds it, else the kernel's reason. */
  const unavailableCause = (part: StoredInversePart, inspection: Inspection) =>
    inOpenDraft(part)
      ? taken(part, inspection) && !part.waiting
        ? ("already_removed" as const)
        : ("edited_since" as const)
      : kernelCause(part, inspection.states([part])[0], inspection);
  function textSelection(entry: Entry, inspection: Inspection) {
    const selection: StoredInversePart[] = [];
    const partial: TextOmission[] = [];
    for (const original of [...entry.parts].sort((a, b) => b.id - a.id)) {
      const refused = refusal(original, inspection);
      if (!refused) selection.push(original);
      else if (refused === "changed")
        partial.push({
          ordinal: original.ordinal,
          cause: unavailableCause(original, inspection),
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
    const inspection = destination.kind === "draft" ? inspect() : inspectAt(destination);
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
    // A closed owner, a gone draft or a deleted document has nothing the card's Undo can take.
    if (destination.closed) return null;
    if (destination.kind === "draft" && destination.state === "gone") return null;
    if (destination.kind === "live" && destination.removed) return null;
    const actionKind = poppableForTurn(turn).has(entry.id)
      ? ("undo" as const)
      : ("revert" as const);
    // A part of an open draft that no change waits on and that was not applied was discarded:
    // its text is not there for an Undo to take out.
    const settled = (part: StoredInversePart) =>
      destination.kind === "draft" && !part.waiting && part.disposition !== "applied";
    return { destination, actionKind, selection: entry.parts.filter((part) => !settled(part)) };
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
    const selection: StoredInversePart[] = [];
    for (const part of entry.parts) {
      const originDestination = document.destinationOf(part.origin);
      const reason = originDestination.closed
        ? "draft_archived"
        : originDestination.kind === "draft" && originDestination.state === "gone"
          ? "discarded"
          : available(part, inspection)
            ? null
            : part.disposition === "discarded"
              ? "discarded"
              : unavailableCause(part, inspection);
      if (reason) skipped.push({ ordinal: part.ordinal, cause: reason });
      else selection.push(part);
    }
    return { selection, skipped };
  }
  return {
    own,
    inspect,
    compute,
    textPlan,
    turnTextPlan,
    takenBy,
    available,
    planTakeOut,
    changed,
    inOpenDraft,
    version,
    queryDestination,
    draftIdOf,
  };
}
