/** One step of an inverse, shared by the model's undo and revert, and the turn card. */

import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type { StoredInversePart } from "./turn-inverse-service.js";

/** Where an inverse writes: Live, as the capture found it. */
export type InverseDestination = {
  kind: "live";
  /** A live file owned by an archived or deleted Work is not writable: why, else null. */
  closed: ClosedOwnerWhy | null;
  removed: boolean;
};

/**
 * One selected original edit, planned against the history the steps before it leave. `at` is
 * its original's place on the history axis. The step takes the original's changes that stand in
 * Live out of it by content.
 */
export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "revert";
  at: number;
  parts: StoredInversePart[];
  destination: InverseDestination;
};
