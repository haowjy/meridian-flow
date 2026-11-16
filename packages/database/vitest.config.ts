import { configDefaults, defineConfig } from "vitest/config";
import { sharedTest } from "../../tools/ci/vitest-shared";

export default defineConfig({
  test: {
    ...sharedTest,
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
    testTimeout: 30_000,
  },
});
