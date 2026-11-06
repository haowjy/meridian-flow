import { expect, test } from "@playwright/test";
import { resolveServerUrl } from "./portless";

const SERVER_URL = resolveServerUrl();

test("opens authenticated placeholder", async ({ page }) => {
  await page.goto("/auth-check");
  await expect(page.getByTestId("auth-check-title")).toHaveText("Authenticated");
  await expect(page.getByTestId("auth-check-user")).not.toHaveText("");
});

test("server auth me returns authenticated user", async ({ page }) => {
  const response = await page.context().request.get(`${SERVER_URL}/api/auth/me`);
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.user.userId).not.toBe("");
});
