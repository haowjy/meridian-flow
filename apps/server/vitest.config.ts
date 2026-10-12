import { configDefaults, defineConfig } from "vitest/config";
import { asVitestGlob, mockedServerTests } from "./vitest.mocked-files";

export default defineConfig({
  test: {
    name: "@meridian/server",
    // Reuse the module graph across files. mockedServerTests stay in
    // vitest.isolated.config.ts; a shared worker would leak those mocks.
    // tools/dev/vitest-isolate-boundary.test.ts rejects a new vi.mock here.
    isolate: false,
    // .output is nitro's build artifact; its compiled *.test.mjs copies must not be collected.
    exclude: [
      ...configDefaults.exclude,
      "**/*.db.test.ts",
      "**/.output/**",
      ...mockedServerTests.map(asVitestGlob),
    ],
    testTimeout: 30_000,
  },
});
