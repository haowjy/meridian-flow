import { defineConfig, devices } from "@playwright/test";
import { browserUrl, resolveDevPorts } from "./tools/dev/lib/dev-ports";

export default defineConfig({
  testDir: "apps/app/e2e",
  testMatch: ["auth.spec.ts", "vertical-slice.spec.ts"],
  timeout: 30_000,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.APP_URL?.trim() || browserUrl(resolveDevPorts(__dirname).app),
    ...devices["Desktop Chrome"],
  },
});
