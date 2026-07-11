import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
