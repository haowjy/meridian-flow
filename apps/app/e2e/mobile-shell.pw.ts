import { expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  findTestUserId,
  openE2eDb,
  type ProjectFixture,
  seedProjectFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.MOBILE_SHELL_DATABASE_URL ?? process.env.DATABASE_URL;

test.describe("project shell selection", () => {
  test("phone-class touch viewport renders mobile project shell", async ({ page }) => {
    test.skip(
      !["phone-touch", "phone-boundary"].includes(test.info().project.name),
      "phone shell assertion runs on touch phone-width projects",
    );
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;
    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Mobile shell",
      });
      await page.goto(`/p/${fixture.projectId}/chats`, { waitUntil: "domcontentloaded" });

      await expect(page.locator('[data-phone-shell="true"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });

  test("narrow fine-pointer desktop keeps desktop shell", async ({ page }) => {
    test.skip(
      !["narrow-desktop", "touch-768-desktop"].includes(test.info().project.name),
      "desktop fallback assertion runs on fine pointer or at least 768px touch projects",
    );
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;
    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Desktop shell",
      });
      await page.goto(`/p/${fixture.projectId}/chats`, { waitUntil: "domcontentloaded" });

      await expect(page.locator('[data-phone-shell="true"]')).toHaveCount(0);
      await expect(page.locator('[data-project-surface-state="active"]').first()).toBeVisible();
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });

  test("bare project address replaces itself with a new chat", async ({ page }) => {
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;
    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Bare address",
      });
      await page.goto("/projects", { waitUntil: "domcontentloaded" });
      await page.goto(`/p/${fixture.projectId}`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`/p/${fixture.projectId}/chats$`));

      // The replace adds no history entry, so Back leaves the project.
      await page.goBack();
      await expect(page).toHaveURL(/\/projects$/);
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });

  test("an invalid address shows the unavailable state and keeps its URL", async ({ page }) => {
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;
    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Invalid address",
      });
      // A pre-grammar document shape: no alias, no redirect.
      const invalid = `/p/${fixture.projectId}/kb/alpha.md`;
      await page.goto(invalid, { waitUntil: "domcontentloaded" });

      await expect(page.getByText("This destination is unavailable.")).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(invalid);
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });
});
