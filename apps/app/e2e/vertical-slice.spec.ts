import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  findTestUserId,
  openE2eDb,
  seedProjectFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.DATABASE_URL;

test.describe("vertical slice", () => {
  test("opens a real project context editor and streams a thread turn", async ({ page }) => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    const fixture = await seedProjectFixture(db, {
      userId: await findTestUserId(db),
      titlePrefix: "Vertical slice",
    });

    try {
      const search = new URLSearchParams({
        screen: "context",
        thread: fixture.threadId,
        scheme: "kb",
        path: "/alpha.md",
      });
      await page.goto(`/project/${fixture.projectId}?${search.toString()}`);
      await expect(page).toHaveURL(new RegExp(`/project/${fixture.projectId}.*screen=context`));

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
      await cleanupProjectFixture(db, fixture).finally(() => db.end());
    }
  });
});

test("source tree has no markdown-replace protocol path", () => {
  const roots = [
    join(process.cwd(), "src"),
    join(process.cwd(), "../server/server"),
    join(process.cwd(), "../../packages"),
  ];
  const hits: string[] = [];
  for (const root of roots) {
    scanForMarkdownReplace(root, hits);
  }
  expect(hits).toEqual([]);
});

function scanForMarkdownReplace(dir: string, hits: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".output") continue;
      scanForMarkdownReplace(path, hits);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith(".spec.ts")) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes('"markdown-replace"') || text.includes("'markdown-replace'")) {
      hits.push(path);
    }
  }
}
