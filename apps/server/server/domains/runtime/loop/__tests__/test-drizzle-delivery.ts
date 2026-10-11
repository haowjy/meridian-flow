/** PostgreSQL delivery fixture using the production lock, inbox and lease implementation. */
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { createDrizzleRepositoriesForTest } from "../../../threads/adapters/drizzle/repositories.js";
import { createDrizzleEventJournalWriter } from "../../../threads/index.js";
import { createDrizzleRuntimeDelivery } from "../../adapters/drizzle/runtime-delivery.js";
import { createDrizzleRunClaim } from "../../adapters/drizzle-run-claim.js";
import { processDetachedWork } from "../../detached-work.js";
import { writeModeSwitchNotice } from "../write-mode-switch.js";
import { createTestNoticePort } from "./runtime-fixtures.js";
export function createTestDrizzleDelivery(
  db: Database,
  overrides: Partial<Parameters<typeof createDrizzleRuntimeDelivery>[1]> = {},
) {
  return createDrizzleRuntimeDelivery(db, {
    backgroundTasks: processDetachedWork,
    workContext: {
      async renderForThread() {
        throw new Error("No Work context configured");
      },
    },
    repos: createDrizzleRepositoriesForTest(db),
    eventWriter: createDrizzleEventJournalWriter(db),
    notices: createTestNoticePort(),
    runClaim: createDrizzleRunClaim(db),
    runStarter: { async start() {} },
    async publishFinalizedReports() {},
    writeModeSwitch: {
      async renderNotice(_threadId, mode) {
        return writeModeSwitchNotice({ archivedAt: null }, mode, false);
      },
      async setWorkDefault(workId, mode) {
        await currentDrizzleDb(db)
          .update(schema.works)
          .set({ defaultAiWriteMode: mode })
          .where(eq(schema.works.id, workId));
      },
    },
    ...overrides,
  });
}
