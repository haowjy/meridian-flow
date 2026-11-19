/** Captured destination, stack, and eligibility facts shared by model reversal commands and history. */

import { REVIEW_BASE_FRAGMENT, readBlocks } from "@meridian/agent-edit/diff";
import type { TurnInverseSkipCause } from "@meridian/contracts/protocol";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { draftSchema, isPending, takeBack, takeOutStanding } from "./draft-changes.js";
import { settledCause } from "./draft-disposition.js";
import { partKey as key } from "./inverse-actions.js";
import type { InverseDestination } from "./inverse-draft-destination.js";
import { type Entry, entries, inspectionActions } from "./model-inverse-selection.js";
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
  const queryDestination = query.draftId
    ? document.destinationOf({ kind: "pending", draftId: query.draftId, rowId: 0 })
    : document.destinationOf({ kind: "live", seq: 0 });
  const draftIdOf = (destination: InverseDestination): string | null =>
    destination.kind === "draft" && destination.state === "active" ? destination.draftId : null;
  const own = entries(document.history, query.threadId);
  const actions = inspectionActions(document.history, own);
  const poppableByTurn = new Map<string, Set<string>>();
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
    cause: "already_removed" | "edited_since" | "draft_archived" | "discarded";
  };
  /** A part an Undo took (the writer's card, the writer's revert, or the model's own undo). */
  const takenBy = (part: StoredInversePart) => actions.actions.byPart.get(key(part));
  const taken = (part: StoredInversePart) => takenBy(part) !== undefined;
  /** A part of an open draft: its text is the draft's; any other part's is Live's. */
  const inOpenDraft = (part: StoredInversePart) => {
    const destination = document.destinationOf(part.origin);
    return destination.kind === "draft" && destination.state === "active";
  };
  /**
   * The text of Live and of each open draft after the steps planned so far, so a later step of
   * one command is judged on what the earlier ones leave, as its commit will.
   */
  const planned = new Map<string, readonly PMNode[]>();
  const committed = new Map<string, readonly PMNode[]>();
  const placeOf = (part: StoredInversePart) =>
    part.origin.kind === "pending" && inOpenDraft(part) ? part.origin.draftId : "live";
  const textIn = (place: string) => {
    let text = planned.get(place) ?? committed.get(place);
    if (!text) {
      const doc = place === "live" ? document.live : document.drafts.get(place)?.doc;
      text = doc ? readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema) : [];
      committed.set(place, text);
    }
    return text;
  };
  const baseOf = (draftId: string) => {
    const doc = document.drafts.get(draftId)?.doc;
    return doc ? readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), draftSchema) : [];
  };
  /**
   * Whether a change of the part still stands where it landed: in Live's text, or in its draft's
   * text and a pending change of it (the capture's reading, until a step has changed the text).
   */
  const stands = (part: StoredInversePart) => {
    const place = placeOf(part);
    if (place === "live") return takeBack(textIn(place), null, [part]).taken.length > 0;
    return planned.has(place)
      ? takeOutStanding(textIn(place), baseOf(place), [part]).taken.length > 0
      : (part.changes?.some((change) => change.state === "stands" && isPending(change)) ?? false);
  };
  /** Records that `parts` were chosen to be taken out of where they landed. */
  const planTakeOut = (destination: InverseDestination, parts: readonly StoredInversePart[]) => {
    const place = draftIdOf(destination) ?? "live";
    planned.set(
      place,
      place === "live"
        ? takeBack(textIn(place), null, parts).live
        : takeOutStanding(textIn(place), baseOf(place), parts).text,
    );
  };
  /** A part whose text no longer reads as the edit wrote it. */
  const changed = (part: StoredInversePart) => !stands(part);
  /** Why a part is not available: the text no longer holds it. */
  const unavailableCause = (part: StoredInversePart) =>
    taken(part) && !part.waiting ? ("already_removed" as const) : ("edited_since" as const);
  function refusal(part: StoredInversePart): TextFailure | null {
    const destination = document.destinationOf(part.origin);
    if (destination.closed) return "draft_archived";
    if (destination.kind === "draft" && destination.state === "gone") return closedPartCause(part);
    if (stands(part)) return null;
    return settledCause(part.disposition) ?? "changed";
  }

  function textSelection(entry: Entry) {
    const selection: StoredInversePart[] = [];
    const partial: TextOmission[] = [];
    for (const original of [...entry.parts].sort((a, b) => b.id - a.id)) {
      const refused = refusal(original);
      if (!refused) selection.push(original);
      else if (refused === "changed")
        partial.push({
          ordinal: original.ordinal,
          cause: unavailableCause(original),
        });
      else return { selection, partial, refusal: refused };
    }
    return { selection, partial, refusal: null };
  }
  function textPlan(entry: Entry, direction: "undo" | "revert") {
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
    const selected = actionKind === "revert" ? revertSelection(entry) : textSelection(entry);
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
  function revertSelection(entry: Entry) {
    const skipped: TextOmission[] = [];
    const selection: StoredInversePart[] = [];
    for (const part of entry.parts) {
      const originDestination = document.destinationOf(part.origin);
      const reason = originDestination.closed
        ? "draft_archived"
        : originDestination.kind === "draft" && originDestination.state === "gone"
          ? "discarded"
          : stands(part)
            ? null
            : part.disposition === "discarded"
              ? "discarded"
              : unavailableCause(part);
      if (reason) skipped.push({ ordinal: part.ordinal, cause: reason });
      else selection.push(part);
    }
    return { selection, skipped };
  }
  return {
    own,
    actions,
    textPlan,
    turnTextPlan,
    takenBy,
    planTakeOut,
    changed,
    inOpenDraft,
    version,
    queryDestination,
    draftIdOf,
  };
}
