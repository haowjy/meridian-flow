import { sharedTest } from "../../tools/ci/vitest-shared";

export default {
  test: {
    ...sharedTest,
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        inline: ["lib0", "yjs"],
      },
    },
  },
};
