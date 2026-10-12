import { expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  findTestUserId,
  login,
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

    await login(page);
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
      await expect(page.locator("[data-mobile-home-list]")).toBeVisible();
      await expect(page.locator("[data-desktop-home-table]")).toHaveCount(0);

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

    await login(page);
    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;
    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Desktop shell",
      });
      await page.goto(`/p/${fixture.projectId}/chats`, { waitUntil: "domcontentloaded" });

      await expect(page.locator('[data-phone-shell="true"]')).toHaveCount(0);
      await expect(page.locator("[data-desktop-home-table]")).toBeVisible();
      await expect(page.locator("[data-mobile-home-list]")).toHaveCount(0);
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });

  test("bare project address replaces itself with the chat index", async ({ page }) => {
    test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");

    await login(page);
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

    await login(page);
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

test("unavailable document masks only its body and navigation opens another document", async ({
  page,
}) => {
  test.skip(!DATABASE_URL, "MOBILE_SHELL_DATABASE_URL or DATABASE_URL is required");
  await login(page);
  const db = openE2eDb(DATABASE_URL ?? "");
  let fixture: ProjectFixture | undefined;
  try {
    fixture = await seedProjectFixture(db, page.request, {
      userId: await findTestUserId(db),
      titlePrefix: "Unavailable document shell",
    });
    // This direct-SQL fixture predates No Work; the Editor requires its locked row.
    await db`INSERT INTO works (project_id, created_by_user_id, name, slug, is_no_work)
      VALUES (${fixture.projectId}, ${await findTestUserId(db)}, 'No Work', NULL, true)`;
    await page.goto(`/p/${fixture.projectId}/editor/kb/alpha`);
    await expect(page.getByText("Seed context.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.goto(`/p/${fixture.projectId}/editor/kb/missing.md`);
    const message = page.getByText("This destination is unavailable.");
    await expect(message).toBeVisible({ timeout: 30_000 });
    const phone = ["phone-touch", "phone-boundary"].includes(test.info().project.name);
    const pane = phone
      ? page.locator("main.main-pane")
      : page.locator('[data-project-surface="context-viewer"]');
    await expect(pane.getByText("This destination is unavailable.")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }).getByText("missing.md"),
    ).toBeVisible();
    if (phone) {
      await page.getByRole("button", { name: "Open chat", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Close chat", exact: true }).click();
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    } else {
      await expect(page.getByRole("tab", { name: "alpha", exact: true })).toBeVisible();
      const expand = page.getByRole("button", { name: /^Expand sidebar/ });
      if (await expand.isVisible()) await expand.click();
    }
    const nav = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(nav).toBeVisible();
    const messageBox = await message.boundingBox();
    const navBox = await nav.boundingBox();
    if (!phone && messageBox && navBox)
      expect(messageBox.x).toBeGreaterThanOrEqual(navBox.x + navBox.width);
    const alpha = nav.getByText("alpha", { exact: true });
    if (!(await alpha.isVisible()))
      await nav.getByRole("button", { name: "Knowledge Base", exact: true }).click();
    await alpha.click();
    await expect(page).toHaveURL(new RegExp(`/p/${fixture.projectId}/editor/kb/alpha$`));
    await expect(message).not.toBeVisible();
    await expect(page.getByText("Seed context.", { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
      db.end(),
    );
  }
});
