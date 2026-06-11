import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("streams an agent edit into the live TipTap editor with attribution", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects\/[^/]+\/agent$/);

  const editor = page.getByTestId("chapter-editor");
  await expect(page.getByTestId("project-shell")).toBeVisible();
  await expect(page.getByTestId("thread-ws-status")).toContainText("subscribed");
  await expect(page.getByTestId("yjs-status")).toContainText("subscribed");

  await expect(editor).toContainText("Chapter 1");

  const uniqueMessage = `Phase 7 final gate ${Date.now()}`;
  await page.getByTestId("chat-composer").fill(uniqueMessage);
  await page.getByTestId("send-message").click();

  const assistantTurn = page.getByTestId("assistant-turn").last();
  await expect(assistantTurn).toContainText(`Acknowledged: ${uniqueMessage}`);
  await expect(page.getByTestId("assistant-turn-state").last()).toHaveText("finished");

  const assistantTurnId = await assistantTurn.getAttribute("data-turn-id");
  expect(assistantTurnId).toBeTruthy();

  await expect(editor).toContainText(`Acknowledged: ${uniqueMessage}`);

  const attribution = page.getByTestId("editor-attribution");
  await expect(attribution).toHaveAttribute("data-origin-type", "agent");
  await expect(attribution).toHaveAttribute("data-actor-turn-id", assistantTurnId ?? "");
  await expect(attribution).toContainText(assistantTurnId ?? "");

  const debugText = await page.evaluate(() => window.__MERIDIAN_EDITOR_DEBUG__?.getText() ?? "");
  expect(debugText).toContain(`Acknowledged: ${uniqueMessage}`);
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
