import { defineConfig } from "@playwright/test";
import { resolveAppUrl } from "./portless";

export default defineConfig({
  testDir: ".",
  testMatch: "chat-performance-smoke.pw.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: resolveAppUrl(),
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
