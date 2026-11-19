/** One step of an inverse, shared by the model's undo and revert, and the turn card. */
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import type { ActiveInverseDestination, InverseDestination } from "./inverse-draft-destination.js";
import type { StoredInversePart } from "./turn-inverse-service.js";

/**
 * One selected original edit, planned against the history the steps before it leave. `at` is
 * its original's place on the history axis; the step lands at its capture-resolved
 * destination. One document's steps may land in both live and a draft within one turn; they
 * still run in the order planned.
 *
 * A step in a live document is a Yjs inverse (`kernel`; the model's only, until the kernel goes).
 * A step in an open draft is `content`: the parts of the original whose changes are read from
 * their delta and taken out of the draft's text as an append, so nothing is computed until the
 * draft's hold is taken. A `manuscript` step takes changes that stand in Live out of Live by
 * content: an edit the AI wrote straight into Live, or a drafted change an Apply took (which also
 * goes out of its draft's base and text, so nothing is left pending).
 */
export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "revert";
  at: number;
} & (
  | { kind: "kernel"; edit: ComputedInverseEdit; destination: InverseDestination }
  | { kind: "content"; parts: StoredInversePart[]; destination: ActiveInverseDestination }
  | {
      kind: "manuscript";
      /** `only`: the changes an Apply took, for a drafted part; every change of a Live part. */
      parts: { part: StoredInversePart; only?: ReadonlySet<number> }[];
      destination: InverseDestination;
    }
);
