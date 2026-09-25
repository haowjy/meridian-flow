/**
 * Drizzle ThreadRepositories aggregate + transaction context. Composes the
 * thread/turn/block/model-response repositories and provides the AsyncLocalStorage
 * Drizzle db so all repositories run inside one transaction. Owns the drizzle DI
 * wiring and the ambient transaction propagation for this domain.
 */

import {
  currentDrizzleDb,
  type DrizzleDatabase,
  type DrizzleDb,
  type DrizzleTransaction,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../../shared/drizzle-transaction.js";
import type { WorkProjectionMutation } from "../../../projects/adapters/work-projection-mutation.js";
import { TurnStartConflictError } from "../../domain/turn-start-transition.js";
import type { InternalThreadRepositories, ThreadStatusReader } from "../../ports/repositories.js";
import { createDrizzleBlockRepository } from "./block-repository.js";
import { createDrizzleProjectChatFeedRepository } from "./chat-feed-repository.js";
import { createDrizzleExecutionReportRepository } from "./execution-report-repository.js";
import { createDrizzleModelResponseRepository } from "./model-response-repository.js";
import { createDrizzleThreadDocumentRepository } from "./thread-document-repository.js";
import { createDrizzleThreadRepository } from "./thread-repository.js";
import { createDrizzleThreadUserStateRepository } from "./thread-user-state-repository.js";
import { createDrizzleThreadWorksRepository } from "./thread-works-repository.js";
import { createDrizzleTurnDocumentTouchRepository } from "./turn-document-touch-repository.js";
import { createDrizzleTurnRepository, lockThreadForTurnTransition } from "./turn-repository.js";
import { createDrizzleWorkChatFeedRepository } from "./work-chat-feed-repository.js";

export { currentDrizzleDb, type DrizzleDatabase, type DrizzleDb, type DrizzleTransaction };

function composeDrizzleRepositories(
  db: DrizzleDatabase,
  workActivity: Pick<WorkProjectionMutation, "touchWorks"> | null,
  statusReader?: ThreadStatusReader,
): InternalThreadRepositories {
  return {
    threads: createDrizzleThreadRepository(db, { statusReader }),
    chatFeed: createDrizzleProjectChatFeedRepository(db),
    workChatFeed: createDrizzleWorkChatFeedRepository(db),
    threadUserState: createDrizzleThreadUserStateRepository(db),
    threadWorks: createDrizzleThreadWorksRepository(db),
    turns: createDrizzleTurnRepository(db, workActivity),
    blocks: createDrizzleBlockRepository(db),
    modelResponses: createDrizzleModelResponseRepository(db),
    executionReports: createDrizzleExecutionReportRepository(db),
    readSnapshot(operation) {
      return runInRootDrizzleReadSnapshot(db, operation);
    },
    threadDocuments: createDrizzleThreadDocumentRepository(db),
    documentTouches: createDrizzleTurnDocumentTouchRepository(db),
    transaction(operation) {
      return runInDrizzleTransaction(db, operation);
    },
    runTurnStartTransition(threadId, expectedActiveLeafTurnId, operation) {
      return runInDrizzleTransaction(db, async () => {
        const thread = await lockThreadForTurnTransition(db, threadId);
        if (thread.activeLeafTurnId !== expectedActiveLeafTurnId) {
          throw new TurnStartConflictError(threadId, "already_running");
        }
        return operation();
      });
    },
  };
}

export function createDrizzleRepositories(
  db: DrizzleDatabase,
  workActivity: Pick<WorkProjectionMutation, "touchWorks">,
  statusReader?: ThreadStatusReader,
): InternalThreadRepositories {
  return composeDrizzleRepositories(db, workActivity, statusReader);
}

/** Isolated adapter tests that do not compose cross-domain projection owners. */
export function createDrizzleRepositoriesForTest(db: DrizzleDatabase): InternalThreadRepositories {
  return composeDrizzleRepositories(db, null);
}
