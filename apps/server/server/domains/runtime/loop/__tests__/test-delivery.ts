/** Shared delivery fixture; production composition uses the concrete database adapter. */

import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunClaim,
  createInMemoryRuntimeDelivery,
  createInMemoryThreadLock,
} from "../../adapters/in-memory/loop-ports.js";
import { createTestNoticePort } from "./test-orchestrator-deps.js";
export function createTestDelivery(
  overrides: Partial<Parameters<typeof createInMemoryRuntimeDelivery>[0]> = {},
) {
  const runClaim = createInMemoryRunClaim();
  return createInMemoryRuntimeDelivery({
    workContext: {
      async renderForThread() {
        throw new Error("No Work context configured");
      },
    },
    repos: createInMemoryRepositories(),
    eventWriter: createInMemoryEventJournalWriter(),
    notices: createTestNoticePort(),
    runClaim,
    inbox: createInMemoryInbox(),
    threadLock: createInMemoryThreadLock(),
    runStarter: { async start() {} },
    schedulePostCommit: (task) => {
      void task();
    },
    ...overrides,
  });
}
