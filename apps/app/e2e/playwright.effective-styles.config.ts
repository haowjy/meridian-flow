import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["effective-styles.pw.ts", "work-detail-geometry.pw.ts"],
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
