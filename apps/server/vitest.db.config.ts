import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

/** Opt-in DB conformance project for destructive Drizzle adapter tests. */
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (RUN_DB_TESTS && !DATABASE_URL) {
  throw new Error(
    "RUN_DB_TESTS requires DATABASE_URL to point at a dedicated throwaway Postgres DB.",
  );
}

const contractsRuntimeEntry = fileURLToPath(
  new URL("../../packages/contracts/src/runtime/index.ts", import.meta.url),
);
const contractsThreadsEntry = fileURLToPath(
  new URL("../../packages/contracts/src/threads/index.ts", import.meta.url),
);
const contractsProtocolEntry = fileURLToPath(
  new URL("../../packages/contracts/src/protocol/index.ts", import.meta.url),
);

export default defineProject({
  resolve: {
    alias: {
      "@meridian/contracts/runtime": contractsRuntimeEntry,
      "@meridian/contracts/threads": contractsThreadsEntry,
      "@meridian/contracts/protocol": contractsProtocolEntry,
    },
  },
  test: {
    name: "server-db",
    environment: "node",
    include: RUN_DB_TESTS ? ["server/**/__conformance__/drizzle-*.test.ts"] : [],
    fileParallelism: false,
  },
});
