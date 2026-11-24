/** One step of an inverse, shared by the model's undo and revert, and the turn card. */

import type { StoredInversePart } from "./turn-inverse-service.js";

/**
 * One selected original edit, planned against the history the steps before it leave. `at` is
 * its original's place on the history axis. The step takes the original's parts that still go
 * back out of it, each in the room it was written in.
 */
export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "revert";
  at: number;
  parts: StoredInversePart[];
};
