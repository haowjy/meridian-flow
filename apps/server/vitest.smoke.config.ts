import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

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
    name: "smoke",
    environment: "node",
    include: ["tests/smoke/**/*.smoke.mts"],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://unit:unit@127.0.0.1:5432/meridian_unit_placeholder",
    },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
