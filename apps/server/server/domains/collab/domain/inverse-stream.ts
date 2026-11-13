/** One step of an inverse, shared by the model's undo, redo and revert, the turn card and a reply's rollback. */
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import type { InverseDestination } from "./inverse-draft-destination.js";

/**
 * One selected original edit, planned against the history the steps before it leave. `at` is
 * its original's place on the history axis; the step lands at its capture-resolved
 * destination. One document's steps may land in both live and a draft within one turn; they
 * still run in the order planned.
 */
export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "redo" | "revert" | "rollback";
  at: number;
  edit: ComputedInverseEdit;
  destination: InverseDestination;
};
