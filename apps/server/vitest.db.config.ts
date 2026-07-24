import { globSync } from "node:fs";
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
const workerDatabaseUrls = process.env.DB_TEST_DATABASE_URLS
  ? (JSON.parse(process.env.DB_TEST_DATABASE_URLS) as string[])
  : [];
const expectedSuites = [
  "apps/server/server/domains/billing/adapters/__conformance__/drizzle-credit-ledger.db.test.ts",
  "apps/server/server/domains/collab/adapters/drizzle-branches.manifest-race.db.test.ts",
  "apps/server/server/domains/collab/adapters/drizzle-change-trail-dispatcher.db.test.ts",
  "apps/server/server/domains/collab/adapters/drizzle-document-activity.db.test.ts",
  "apps/server/server/domains/collab/branch-push-projection.db.test.ts",
  "apps/server/server/domains/collab/branch-push-settlement-oracle.db.test.ts",
  "apps/server/server/domains/collab/change-trail-lifecycle.db.test.ts",
  "apps/server/server/domains/collab/change-trail-persistence-atomicity.db.test.ts",
  "apps/server/server/domains/collab/collab-domain.reverse-turn.db.test.ts",
  "apps/server/server/domains/collab/cross-work-merge-probe.db.test.ts",
  "apps/server/server/domains/collab/response-transaction-atomicity.db.test.ts",
  "apps/server/server/domains/collab/writer-ingress.db.test.ts",
  "apps/server/server/domains/context/adapters/context-fs/context-fs.create-untitled.db.test.ts",
  "apps/server/server/domains/context/adapters/context-fs/drizzle-store.db.test.ts",
  "apps/server/server/domains/context/adapters/thread-uploads/__conformance__/drizzle-internal-upload-document-store.db.test.ts",
  "apps/server/server/domains/notices/adapters/drizzle-notice-port.db.test.ts",
  "apps/server/server/domains/projects/project-bootstrap-authority-head.db.test.ts",
  "apps/server/server/domains/threads/adapters/drizzle/thread-head-projection.db.test.ts",
  "apps/server/server/lib/compose.runtime-settlement.db.test.ts",
  "apps/server/server/lib/routes/context-create-read.db.test.ts",
  "apps/server/server/lib/routes/context-create-untitled.db.test.ts",
  "apps/server/server/lib/routes/context-move.db.test.ts",
  "packages/database/src/consume-credit-lots-fifo.db.test.ts",
  "packages/database/src/event-journal.db.test.ts",
  "packages/database/src/fresh-migrations.db.test.ts",
] as const;
const discoveredSuites = globSync("{apps/server,packages/database}/**/*.db.test.ts", {
  cwd: root,
}).sort();
const missingSuites = expectedSuites.filter((suite) => !discoveredSuites.includes(suite));
const unexpectedSuites = discoveredSuites.filter(
  (suite) => !expectedSuites.includes(suite as (typeof expectedSuites)[number]),
);
if (missingSuites.length > 0 || unexpectedSuites.length > 0) {
  throw new Error(
    [
      missingSuites.length > 0 ? `missing: ${missingSuites.join(", ")}` : undefined,
      unexpectedSuites.length > 0 ? `unregistered: ${unexpectedSuites.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("; ")
      .replace(/^/, "DB suite manifest mismatch: "),
  );
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
    setupFiles: [fileURLToPath(new URL("../../tools/ci/db-test-worker-setup.ts", import.meta.url))],
    fileParallelism: workerDatabaseUrls.length > 0,
    maxWorkers: workerDatabaseUrls.length || 1,
    // Vitest's 5s default is too tight for the heavier real-Postgres suites, and a
    // timed-out test's async DB work is NOT cancelled — it overlaps the next
    // test's destructive reset and corrupts it. 30s matches the server/database
    // unit configs. (#314)
    testTimeout: 30_000,
    reporters: [
      "default",
      fileURLToPath(new URL("../../tools/ci/db-test-reporter.ts", import.meta.url)),
    ],
  },
});
