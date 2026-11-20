/** One step of an inverse, shared by the model's undo and revert, and the turn card. */
import type { ActiveInverseDestination, InverseDestination } from "./inverse-draft-destination.js";
import type { StoredInversePart } from "./turn-inverse-service.js";

/**
 * One selected original edit, planned against the history the steps before it leave. `at` is
 * its original's place on the history axis; the step lands at its capture-resolved
 * destination. One document's steps may land in both live and a draft within one turn; they
 * still run in the order planned.
 *
 * A step in an open draft is `content`: the parts of the original whose changes are read from
 * their delta and taken out of the draft's text as an append, so nothing is computed until the
 * draft's hold is taken. A `manuscript` step takes the changes of an edit the AI wrote straight
 * into Live out of Live by content, where they still stand. A change an Apply took is the Apply's:
 * its Un-Apply takes it back.
 */
export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "revert";
  at: number;
} & (
  | { kind: "content"; parts: StoredInversePart[]; destination: ActiveInverseDestination }
  | {
      kind: "manuscript";
      parts: StoredInversePart[];
      destination: InverseDestination;
    }
);
