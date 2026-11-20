import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";

import appConfig from "../../../../../vitest.config";

export default mergeConfig(
  appConfig,
  defineConfig({
    root: fileURLToPath(new URL("../../../../..", import.meta.url)),
    test: { include: ["src/core/editor/.context/qa/manuscript-gate.probe.ts"] },
  }),
);
