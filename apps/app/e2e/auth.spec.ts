import { expect, request, test } from "@playwright/test";
import { resolveServerUrl } from "./portless";

const SERVER_URL = resolveServerUrl();

test("opens authenticated placeholder", async ({ page }) => {
  await page.goto("/auth-check");
  await expect(page.getByTestId("auth-check-title")).toHaveText("Authenticated");
  await expect(page.getByTestId("auth-check-user")).not.toHaveText("");
});

test("server auth me rejects unauthenticated requests", async () => {
  const context = await request.newContext({
    baseURL: SERVER_URL,
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const response = await context.get("/api/auth/me");
    expect(response.status()).toBe(401);
  } finally {
    await context.dispose();
  }
});

test("server auth me returns authenticated user", async ({ page }) => {
  const response = await page.context().request.get(`${SERVER_URL}/api/auth/me`);
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.user.userId).not.toBe("");
});
