import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  // A long FUZZ_SCRIPTS run takes longer than the default 5 s.
  test: {
    environment: "node",
    include: ["src/model/.context/qa/fork-lowering.probe.ts"],
    testTimeout: 0,
  },
});
