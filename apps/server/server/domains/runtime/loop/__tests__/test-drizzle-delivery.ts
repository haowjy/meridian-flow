/** PostgreSQL delivery fixture using the production lock, inbox and lease implementation. */
import type { Database } from "@meridian/database";
import { createDrizzleRepositoriesForTest } from "../../../threads/adapters/drizzle/repositories.js";
import { createDrizzleEventJournalWriter } from "../../../threads/index.js";
import { createDrizzleRuntimeDelivery } from "../../adapters/drizzle/runtime-delivery.js";
import { createDrizzleRunClaim } from "../../adapters/drizzle-run-claim.js";
import { createTestNoticePort } from "./runtime-fixtures.js";
export function createTestDrizzleDelivery(
  db: Database,
  overrides: Partial<Parameters<typeof createDrizzleRuntimeDelivery>[1]> = {},
) {
  return createDrizzleRuntimeDelivery(db, {
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
    ...overrides,
  });
}
