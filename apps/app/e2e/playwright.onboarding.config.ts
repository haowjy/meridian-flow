import { defineConfig, devices } from "@playwright/test";
import { resolveAppUrl } from "./portless";

const APP_URL = resolveAppUrl();

export default defineConfig({
  testDir: ".",
  testMatch: "onboarding.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: APP_URL,
    ignoreHTTPSErrors: true,
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
