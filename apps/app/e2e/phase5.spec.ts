import { expect, test } from "@playwright/test";
import { openE2eDb, prepareAuthenticatedProjectAccess } from "./support/e2e-db";

const DATABASE_URL = process.env.DATABASE_URL;

test.describe("project workspace", () => {
  test.beforeEach(async () => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    try {
      await prepareAuthenticatedProjectAccess(db);
    } finally {
      await db.end();
    }
  });

  test("opens the real project route and streams an assistant turn", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/project\/[^/?]+/);

    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    expect(projectId).toBeTruthy();

    await page.goto(`/project/${projectId}?screen=chat`);
    await expect(page).toHaveURL(/\/project\/[^/?]+\?screen=chat(&thread=[^&]+)?$/);

    const composer = page.getByPlaceholder("Reply to the agent, or steer the analysis…");
    await expect(composer).toBeVisible();

    await composer.fill("Draft the next beat.");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.locator('[data-turn-role="user"]').last()).toContainText(
      "Draft the next beat.",
    );
    await expect(page.locator('[data-turn-role="assistant"]').last()).toContainText(
      "Acknowledged: Draft the next beat.",
    );
    await expect(page.locator('[data-turn-role="assistant"]').last()).toHaveAttribute(
      "data-turn-status",
      "complete",
    );
  });
});
