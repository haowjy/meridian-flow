import { defineConfig, devices } from "@playwright/test";
import { resolveAppUrl } from "./portless";

// phase5/vertical-slice assert deterministic mock gateway text.
process.env.MODEL_PROVIDER = "mock";

const APP_URL = resolveAppUrl();

export default defineConfig({
  testDir: ".",
  testMatch: ["auth.spec.ts", "vertical-slice.spec.ts"],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: APP_URL,
    ignoreHTTPSErrors: true,
    ...devices["Desktop Chrome"],
  },
});
