import { expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  findTestUserId,
  openE2eDb,
  type ProjectFixture,
  seedProjectFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.DATABASE_URL;

test.describe("vertical slice", () => {
  test("keeps the workspace mounted when authenticated routes invalidate", async ({ page }) => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;

    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Auth invalidation",
      });
      // Opening the chat makes it the project's current chat, which the Editor docks.
      await page.goto(`/p/${fixture.projectId}/chats/${fixture.threadId}`);
      await page.goto(`/p/${fixture.projectId}/editor/kb/alpha.md`);

      const editor = page.locator(".ProseMirror").first();
      const dockComposer = page.locator(`[data-debug-composer="${fixture.threadId}"] textarea`);
      await expect(editor).toBeVisible();
      await expect(dockComposer).toBeVisible();

      const authMe = await page.evaluate(async () => {
        const response = await fetch("/api/auth/me");
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          body: await response.json(),
        };
      });
      expect(authMe.status).toBe(200);
      expect(authMe.contentType).toContain("application/json");
      expect(authMe.body.user.userId).not.toBe("");

      const unsentText = `Unsent invalidation check ${Date.now()}`;
      await dockComposer.fill(unsentText);
      await page.evaluate(async () => {
        const router = (
          window as typeof window & {
            __TSR_ROUTER__?: { invalidate: () => Promise<void> };
          }
        ).__TSR_ROUTER__;
        if (!router) throw new Error("TanStack router debug handle is unavailable");
        await router.invalidate();
      });

      await expect(page.getByText("Something went wrong!")).toHaveCount(0);
      await expect(editor).toBeVisible();
      await expect(dockComposer).toHaveValue(unsentText);
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });

  test("opens a real project context editor and streams a thread turn", async ({ page }) => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;

    try {
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Vertical slice",
      });
      // Opening the chat makes it the project's current chat, which the Editor docks.
      await page.goto(`/p/${fixture.projectId}/chats/${fixture.threadId}`);
      await page.goto(`/p/${fixture.projectId}/editor/kb/alpha.md`);
      await expect(page).toHaveURL(new RegExp(`/p/${fixture.projectId}/editor/kb/alpha\\.md`));

      const editor = page.locator(".ProseMirror").first();
      await expect(editor).toBeVisible();
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await expect(editor).toContainText("Alpha");
      await expect(editor).toContainText("Seed context.");

      const dockComposer = page.locator(`[data-debug-composer="${fixture.threadId}"] textarea`);
      await expect(dockComposer).toBeVisible();

      const uniqueMessage = `Vertical slice ${Date.now()}`;
      await dockComposer.fill(uniqueMessage);
      await page
        .locator(`[data-debug-composer="${fixture.threadId}"]`)
        .getByRole("button", { name: "Send message" })
        .click();

      await expect(page.locator('[data-turn-role="user"]').last()).toContainText(uniqueMessage);
      const assistantTurn = page.locator('[data-turn-role="assistant"]').last();
      await expect(assistantTurn).toContainText(`Acknowledged: ${uniqueMessage}`);
      await expect(assistantTurn).toHaveAttribute("data-turn-status", "complete");
      await expect(editor).toHaveAttribute("contenteditable", "true");
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });
});
