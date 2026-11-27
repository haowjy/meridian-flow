import {
  type DrizzleDatabase,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../../shared/drizzle-transaction.js";
import type { LineageScratchLifecycle } from "../../../context/index.js";
import type { WorkProjectionMutation } from "../../../projects/adapters/work-projection-mutation.js";
import { TurnStartConflictError } from "../../domain/turn-start-transition.js";
import type { InternalThreadRepositories, ThreadStatusReader } from "../../ports/repositories.js";
import { createDrizzleAskRepository } from "./ask-repository.js";
import { createDrizzleBlockRepository } from "./block-repository.js";
import { createDrizzleProjectChatFeedRepository } from "./chat-feed-repository.js";
import { createDrizzleExecutionReportRepository } from "./execution-report-repository.js";
import { createDrizzleThreadMediaInclusionRepository } from "./media-inclusion-repository.js";
import { createDrizzleModelResponseRepository } from "./model-response-repository.js";
import { createDrizzlePromptBakeRepository } from "./prompt-bake-repository.js";
import { createDrizzleThreadDocumentRepository } from "./thread-document-repository.js";
import { createDrizzleThreadRepository } from "./thread-repository.js";
import { createDrizzleThreadUserStateRepository } from "./thread-user-state-repository.js";
import { createDrizzleThreadWorksRepository } from "./thread-works-repository.js";
import { createDrizzleTurnRepository, lockThreadForTurnTransition } from "./turn-repository.js";

export function createDrizzleRepositories(
  db: DrizzleDatabase,
  workActivity: Pick<WorkProjectionMutation, "touchWorks" | "recountAfterCommit"> | null,
  lineageScratch: LineageScratchLifecycle,
  statusReader?: ThreadStatusReader,
): InternalThreadRepositories {
  return {
    asks: createDrizzleAskRepository(db),
    threads: createDrizzleThreadRepository(db, { statusReader, lineageScratch }),
    chatFeed: createDrizzleProjectChatFeedRepository(db),
    threadUserState: createDrizzleThreadUserStateRepository(db),
    threadWorks: createDrizzleThreadWorksRepository(db, workActivity),
    turns: createDrizzleTurnRepository(db, workActivity),
    promptBakes: createDrizzlePromptBakeRepository(db),
    blocks: createDrizzleBlockRepository(db),
    mediaInclusions: createDrizzleThreadMediaInclusionRepository(db),
    modelResponses: createDrizzleModelResponseRepository(db),
    executionReports: createDrizzleExecutionReportRepository(db),
    readSnapshot(operation) {
      return runInRootDrizzleReadSnapshot(db, operation);
    },
    threadDocuments: createDrizzleThreadDocumentRepository(db),
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
