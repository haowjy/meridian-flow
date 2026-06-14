import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { resolveAppUrl } from "./portless";

const APP_URL = resolveAppUrl();
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.STATE_PATH ?? resolve(HERE, "../.auth/state.json");

export default defineConfig({
  testDir: ".",
  testMatch: ["auth.spec.ts", "phase5.spec.ts", "vertical-slice.spec.ts"],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: APP_URL,
    ignoreHTTPSErrors: true,
    storageState: STATE_PATH,
    ...devices["Desktop Chrome"],
  },
});
