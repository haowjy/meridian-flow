/** Orchestrates retry, reconciliation, and delivery behind one polling seam. */
import type { Database } from "@meridian/database";
import type { EventJournalWriter } from "../../threads/ports/index.js";
import type { ThreadEventHub } from "../../threads/thread-event-hub.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";
import { createDrizzleChangeTrailDispatcher } from "./drizzle-change-trail-dispatcher.js";
import { createDrizzleChangeTrailReconciler } from "./drizzle-change-trail-reconciler.js";
import { retryTurnTrailWork } from "./drizzle-turn-trail-work.js";

export type ChangeTrailWorker = { drain(): Promise<number> };

export function createChangeTrailWorker(input: {
  db: Database;
  journalWriter: EventJournalWriter;
  eventHub: Pick<ThreadEventHub, "publishPersistedEvent">;
  retryBranch?: (branchId: string) => Promise<unknown>;
  onRetryExhausted?: (threadId: string, documentId: string) => void;
}): ChangeTrailWorker {
  const aggregate = createDrizzleChangeTrailAggregateWriter(input.db);
  const reconciler = createDrizzleChangeTrailReconciler(aggregate);
  const dispatcher = createDrizzleChangeTrailDispatcher(input);
  return {
    async drain() {
      await retryTurnTrailWork(input.db, input.retryBranch, input.onRetryExhausted);
      await reconciler.reconcile();
      return dispatcher.drain();
    },
  };
}
