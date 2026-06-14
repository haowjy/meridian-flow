import { defineConfig, devices } from "@playwright/test";
import { resolveAppUrl } from "./portless";

export default defineConfig({
  testDir: ".",
  testMatch: "mobile-shell.pw.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: resolveAppUrl(),
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "phone-touch",
      use: {
        ...devices["iPhone 14 Pro"],
        browserName: "chromium",
        viewport: { width: 393, height: 852 },
      },
    },
    {
      name: "phone-boundary",
      use: {
        browserName: "chromium",
        viewport: { width: 767, height: 900 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "narrow-desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 500, height: 900 },
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: "touch-768-desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 768, height: 900 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
