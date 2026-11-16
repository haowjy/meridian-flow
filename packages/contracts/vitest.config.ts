import { sharedTest } from "../../tools/ci/vitest-shared";

export default {
  test: {
    ...sharedTest,
    environment: "node",
    // Pure contracts share immutable modules; suites must not mock modules or process globals.
    isolate: false,
    include: ["src/**/*.test.ts"],
  },
};
