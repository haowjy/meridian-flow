import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .output is nitro's build artifact; its compiled *.test.mjs copies must not be collected.
    exclude: [...configDefaults.exclude, "**/*.db.test.ts", "**/.output/**"],
    testTimeout: 30_000,
  },
});
