import { defineConfig } from "vitest/config";
import { sharedTest } from "../../tools/ci/vitest-shared";
import { asVitestGlob, mockedServerTests } from "./vitest.mocked-files";

export default defineConfig({
  test: {
    ...sharedTest,
    name: "@meridian/server-isolated",
    isolate: true,
    include: mockedServerTests.map(asVitestGlob),
    testTimeout: 30_000,
  },
});
