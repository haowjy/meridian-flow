import { sharedTest } from "../../tools/ci/vitest-shared";

export default {
  test: {
    ...sharedTest,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
};
