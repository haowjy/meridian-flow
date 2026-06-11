import { expect, test } from "@playwright/test";

test("opens project shell, loads chapter, and streams an assistant turn", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects\/[^/]+\/agent$/);

  await expect(page.getByTestId("project-shell")).toBeVisible();
  const projectId = await page.getByTestId("project-id").textContent();
  expect(page.url()).toContain(`/projects/${projectId}/agent`);
  await expect(page.getByTestId("chapter-editor")).toContainText("# Chapter 1");
  await expect(page.getByTestId("thread-ws-status")).toContainText("subscribed");
  await expect(page.getByTestId("yjs-status")).toContainText("subscribed");

  await page.getByTestId("chat-composer").fill("Draft the next beat.");
  await page.getByTestId("send-message").click();

  await expect(page.getByTestId("assistant-turn").last()).toContainText(
    "Acknowledged: Draft the next beat.",
  );
  await expect(page.getByTestId("assistant-turn-state").last()).toHaveText("finished");
});
