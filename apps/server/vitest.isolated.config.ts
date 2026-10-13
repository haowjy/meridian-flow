import { defineConfig } from "vitest/config";
import { asVitestGlob, mockedServerTests } from "./vitest.mocked-files";

// vi.mock is file-scoped only when the file has its own module graph.
// The list is shared with the isolate:false project so a file cannot be
// excluded from one gate and forgotten by the other.
export default defineConfig({
  test: {
    name: "@meridian/server-isolated",
    isolate: true,
    include: mockedServerTests.map(asVitestGlob),
    testTimeout: 30_000,
  },
});
