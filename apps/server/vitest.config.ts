import { configDefaults, defineConfig } from "vitest/config";
import { sharedTest } from "../../tools/ci/vitest-shared";
import { asVitestGlob, mockedServerTests } from "./vitest.mocked-files";

export default defineConfig({
  test: {
    ...sharedTest,
    name: "@meridian/server",
    // Mocked server tests stay in the isolated config; a shared worker would leak their vi.mock
    isolate: false,
    exclude: [
      ...configDefaults.exclude,
      "**/*.db.test.ts",
      "**/.output/**",
      ...mockedServerTests.map(asVitestGlob),
    ],
    testTimeout: 30_000,
  },
});
