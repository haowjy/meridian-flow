import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import { defineProject } from "vitest/config";

/** Canonical, destructive PostgreSQL suite spanning the server and database package. */
const DATABASE_URL = process.env.DATABASE_URL;
if (process.env.RUN_DB_TESTS !== "1" || !DATABASE_URL) {
  throw new Error("DB tests require RUN_DB_TESTS=1 and a dedicated throwaway DATABASE_URL.");
}
assertThrowawayDatabaseForRunDbTests(DATABASE_URL);

const root = fileURLToPath(new URL("../..", import.meta.url));
const expectedSuites = [
  "apps/server/server/domains/collab/response-transaction-atomicity.db.test.ts",
  "apps/server/server/domains/collab/change-trail-persistence-atomicity.db.test.ts",
  "apps/server/server/domains/collab/change-trail-lifecycle.db.test.ts",
  "apps/server/server/domains/collab/adapters/drizzle-change-trail-delivery.db.test.ts",
  "apps/server/server/domains/collab/collab-domain.reverse-turn.db.test.ts",
  "packages/database/src/fresh-migrations.db.test.ts",
];
const missingSuites = expectedSuites.filter((suite) => !existsSync(`${root}/${suite}`));
if (missingSuites.length > 0) {
  throw new Error(`Required DB suites are missing: ${missingSuites.join(", ")}`);
}

export default defineProject({
  root,
  resolve: {
    alias: {
      "@meridian/contracts/runtime": fileURLToPath(
        new URL("../../packages/contracts/src/runtime/index.ts", import.meta.url),
      ),
      "@meridian/contracts/threads": fileURLToPath(
        new URL("../../packages/contracts/src/threads/index.ts", import.meta.url),
      ),
      "@meridian/contracts/protocol": fileURLToPath(
        new URL("../../packages/contracts/src/protocol/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "db",
    environment: "node",
    include: ["**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/.{git,nx}/**"],
    fileParallelism: false,
    reporters: [
      "default",
      fileURLToPath(new URL("../../tools/ci/db-test-reporter.ts", import.meta.url)),
    ],
  },
});
