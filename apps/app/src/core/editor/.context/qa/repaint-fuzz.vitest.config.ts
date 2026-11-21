import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";

import appConfig from "../../../../../vitest.config";

export default mergeConfig(
  appConfig,
  defineConfig({
    root: fileURLToPath(new URL("../../../../..", import.meta.url)),
    // A long FUZZ_EDITS run takes longer than the default 5 s.
    test: { include: ["src/core/editor/.context/qa/repaint-fuzz.probe.ts"], testTimeout: 0 },
  }),
);
