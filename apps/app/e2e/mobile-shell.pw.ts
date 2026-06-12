import { expect, test } from "@playwright/test";
import {
  cleanupWorkbenchFixture,
  findTestUserId,
  login,
  openE2eDb,
  seedWorkbenchFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.MOBILE_SHELL_DATABASE_URL ?? process.env.DATABASE_URL;

test.describe("workbench shell selection", () => {
  test("phone-class touch viewport renders mobile workbench shell", async ({ page }) => {
    test.skip(
      !["phone-touch", "phone-boundary"].includes(test.info().project.name),
      "phone shell assertion runs on touch phone-width projects",
    );
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    await login(page);
    const db = openE2eDb(DATABASE_URL ?? "");
    const fixture = await seedWorkbenchFixture(db, {
      userId: await findTestUserId(db),
      titlePrefix: "Mobile shell",
    });
    try {
      await page.goto(`/workbench/${fixture.projectId}`, { waitUntil: "domcontentloaded" });

      await expect(page.locator('[data-phone-shell="true"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
      await expect(page.locator("[data-mobile-home-list]")).toBeVisible();
      await expect(page.locator("[data-desktop-home-table]")).toHaveCount(0);

      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    } finally {
      await cleanupWorkbenchFixture(db, fixture).finally(() => db.end());
    }
  });

  test("narrow fine-pointer desktop keeps desktop shell", async ({ page }) => {
    test.skip(
      !["narrow-desktop", "touch-768-desktop"].includes(test.info().project.name),
      "desktop fallback assertion runs on fine pointer or at least 768px touch projects",
    );
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    await login(page);
    const db = openE2eDb(DATABASE_URL ?? "");
    const fixture = await seedWorkbenchFixture(db, {
      userId: await findTestUserId(db),
      titlePrefix: "Desktop shell",
    });
    try {
      await page.goto(`/workbench/${fixture.projectId}`, { waitUntil: "domcontentloaded" });

      await expect(page.locator('[data-phone-shell="true"]')).toHaveCount(0);
      await expect(page.locator("[data-desktop-home-table]")).toBeVisible();
      await expect(page.locator("[data-mobile-home-list]")).toHaveCount(0);
    } finally {
      await cleanupWorkbenchFixture(db, fixture).finally(() => db.end());
    }
  });
});
