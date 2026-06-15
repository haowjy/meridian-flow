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
} from "../../../../shared/drizzle-transaction.js";
import type { InternalThreadRepositories } from "../../ports/repositories.js";
import { createDrizzleBlockRepository } from "./block-repository.js";
import { createDrizzleModelResponseRepository } from "./model-response-repository.js";
import { createDrizzleThreadDocumentRepository } from "./thread-document-repository.js";
import { createDrizzleThreadRepository } from "./thread-repository.js";
import { createDrizzleTurnDocumentTouchRepository } from "./turn-document-touch-repository.js";
import { createDrizzleTurnRepository } from "./turn-repository.js";
import { createDrizzleUsageRecorder } from "./usage-recorder.js";

export { currentDrizzleDb, type DrizzleDatabase, type DrizzleDb, type DrizzleTransaction };

export function createDrizzleRepositories(db: DrizzleDatabase): InternalThreadRepositories {
  const usageRecorder = createDrizzleUsageRecorder(db);
  return {
    threads: createDrizzleThreadRepository(db),
    turns: createDrizzleTurnRepository(db),
    blocks: createDrizzleBlockRepository(db),
    modelResponses: createDrizzleModelResponseRepository(db),
    threadDocuments: createDrizzleThreadDocumentRepository(db),
    documentTouches: createDrizzleTurnDocumentTouchRepository(db),
    transaction(operation) {
      return runInDrizzleTransaction(db, operation);
    },
    recordModelResponseUsage: usageRecorder.recordModelResponseUsage,
  };
}
