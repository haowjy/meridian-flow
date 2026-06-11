import { expect, test } from "@playwright/test";

test("streams an agent edit into the live editor with attribution", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects\/[^/]+\/agent$/);

  const editor = page.getByTestId("chapter-editor");
  await expect(page.getByTestId("project-shell")).toBeVisible();
  await expect(page.getByTestId("thread-ws-status")).toContainText("subscribed");
  await expect(page.getByTestId("yjs-status")).toContainText("subscribed");

  const initialMarkdown = await editor.inputValue();
  expect(initialMarkdown).toContain("# Chapter 1");

  const uniqueMessage = `Phase 7 final gate ${Date.now()}`;
  await page.getByTestId("chat-composer").fill(uniqueMessage);
  await page.getByTestId("send-message").click();

  const assistantTurn = page.getByTestId("assistant-turn").last();
  await expect(assistantTurn).toContainText(`Acknowledged: ${uniqueMessage}`);
  await expect(page.getByTestId("assistant-turn-state").last()).toHaveText("finished");

  const assistantTurnId = await assistantTurn.getAttribute("data-turn-id");
  expect(assistantTurnId).toBeTruthy();

  await expect(editor).toHaveValue(new RegExp(`Acknowledged: ${escapeRegExp(uniqueMessage)}`));

  const attribution = page.getByTestId("editor-attribution");
  await expect(attribution).toHaveAttribute("data-origin-type", "agent");
  await expect(attribution).toHaveAttribute("data-actor-turn-id", assistantTurnId ?? "");
  await expect(attribution).toContainText(assistantTurnId ?? "");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
