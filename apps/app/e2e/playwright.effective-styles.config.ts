import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "context-entry-actions.pw.ts",
    "effective-styles.pw.ts",
    "home-row-component-geometry.pw.ts",
    "work-detail-component-geometry.pw.ts",
  ],
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  projects: [
    {
      name: "fine-pointer",
      use: { browserName: "chromium", viewport: { width: 800, height: 600 } },
    },
    {
      name: "coarse-pointer",
      use: {
        browserName: "chromium",
        viewport: { width: 393, height: 600 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
