import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
    include: ["**/*.test.ts"],
  },
});
