/** One step of an inverse, shared by the model's undo and revert, and the turn card. */

import type { TakenRoom } from "./model-reversal-planner.js";
import type { StoredInversePart } from "./turn-inverse-service.js";

/**
 * One selected original edit, taken back on what the steps before it leave. `at` is its
 * original's place on the history axis. `parts` are the original's parts that went back, each in
 * the room it was written in; `rooms` what each of those rooms commits (none on a ledger-only read).
 */
export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "revert";
  at: number;
  parts: StoredInversePart[];
  rooms: TakenRoom[];
};
