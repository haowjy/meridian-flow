import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { sharedTest } from "../../tools/ci/vitest-shared";

export default defineProject({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    ...sharedTest,
    name: "web",
    environment: "node",
  },
});
