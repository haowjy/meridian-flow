/** Reconciles terminal turn facts through the sole change-trail aggregate writer. */
import type { ChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";

export type ChangeTrailReconciler = { reconcile(): Promise<void> };

export function createDrizzleChangeTrailReconciler(
  aggregate: ChangeTrailAggregateWriter,
): ChangeTrailReconciler {
  return { reconcile: () => aggregate.reconcileTerminalOwners() };
}
