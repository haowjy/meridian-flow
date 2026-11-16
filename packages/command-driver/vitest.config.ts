import { sharedTest } from "../../tools/ci/vitest-shared";

export default {
  test: {
    ...sharedTest,
    environment: "node",
    isolate: false,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.bench.test.ts"],
  },
};
