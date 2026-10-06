/** Orchestrates trail work settlement, reconciliation, and delivery behind one polling seam. */
import type { Database } from "@meridian/database";
import type { EventJournalWriter } from "../../threads/ports/index.js";
import type { ThreadEventHub } from "../../threads/thread-event-hub.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";
import { createDrizzleChangeTrailDispatcher } from "./drizzle-change-trail-dispatcher.js";
import { createDrizzleChangeTrailReconciler } from "./drizzle-change-trail-reconciler.js";
import { settleTurnTrailWork } from "./drizzle-turn-trail-work.js";

export type ChangeTrailWorker = { drain(): Promise<number> };

export function createChangeTrailWorker(input: {
  db: Database;
  journalWriter: EventJournalWriter;
  eventHub: Pick<ThreadEventHub, "invalidateCommittedJournal">;
  recoverPendingLiveSettlements?: () => Promise<number>;
}): ChangeTrailWorker {
  const aggregate = createDrizzleChangeTrailAggregateWriter(input.db);
  const reconciler = createDrizzleChangeTrailReconciler(aggregate);
  const dispatcher = createDrizzleChangeTrailDispatcher(input);
  return {
    async drain() {
      await input.recoverPendingLiveSettlements?.();
      await settleTurnTrailWork(input.db);
      await reconciler.reconcile();
      return dispatcher.drain();
    },
  };
}
