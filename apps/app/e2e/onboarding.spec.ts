import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  findTestUserId,
  login,
  markOnboardingCompleted,
  openE2eDb,
  resetUserOnboardingState,
  seedProjectFixture,
} from "./support/e2e-db";

const HERE = dirname(fileURLToPath(import.meta.url));

function envFileValue(key: string): string | undefined {
  try {
    const envText = readFileSync(resolve(HERE, "../../../.env"), "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      if (trimmed.slice(0, separator) === key) return trimmed.slice(separator + 1);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const DATABASE_URL =
  process.env.ONBOARDING_DATABASE_URL ?? process.env.DATABASE_URL ?? envFileValue("DATABASE_URL");

async function confirmVisibleCheckpoint(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('button[type="submit"]:has-text("Confirm"):not([disabled])').click();
}

test.describe("onboarding gate", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!DATABASE_URL, "ONBOARDING_DATABASE_URL or DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    try {
      const userId = await findTestUserId(db);
      await resetUserOnboardingState(db, userId);
    } finally {
      await db.end();
    }
    await login(page);
  });

  test("redirects new users from /projects into the guided onboarding flow", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByTestId("onboarding-flow")).toBeVisible();
    await expect(page.getByTestId("onboarding-loading")).toHaveCount(0);
  });

  test("persists onboarding progress across leave and return", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page.getByTestId("onboarding-flow")).toBeVisible();

    await page.locator("#checkpoint-field-projectName").fill("Cradle of Stars");
    await page.locator("#checkpoint-field-writingType").selectOption("progression fantasy");
    await confirmVisibleCheckpoint(page);

    await expect(page.getByText("Checkpoint resolved")).toBeVisible();
    await expect(page.getByText("Project basics")).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await page.goto("/auth-check");
    await page.goto("/onboarding");

    await expect(page.getByTestId("onboarding-flow")).toBeVisible();
    await expect(page.getByText("Cradle of Stars · progression fantasy")).toBeVisible();
    await expect(page.locator("#checkpoint-field-referralSource")).toBeVisible();
  });

  test("completes onboarding, creates a project, and lands on /projects/:id/agent", async ({
    page,
  }) => {
    await page.goto("/onboarding");
    await expect(page.getByTestId("onboarding-flow")).toBeVisible();

    await page.locator("#checkpoint-field-projectName").fill("Launch Serial");
    await page.locator("#checkpoint-field-writingType").selectOption("LitRPG");
    await confirmVisibleCheckpoint(page);

    await page.locator("#checkpoint-field-referralSource").fill("writer forum");
    await confirmVisibleCheckpoint(page);

    await page.locator("#checkpoint-field-path").selectOption("start_chatting");
    await confirmVisibleCheckpoint(page);

    await expect(page).toHaveURL(/\/projects\/[^/]+\/agent$/, { timeout: 45_000 });
    await expect(page.getByTestId("project-shell")).toBeVisible();
  });
});

test.describe("existing users", () => {
  test("users with projects are not trapped by onboarding", async ({ page }) => {
    test.skip(!DATABASE_URL, "ONBOARDING_DATABASE_URL or DATABASE_URL is required");

    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: Awaited<ReturnType<typeof seedProjectFixture>> | null = null;
    try {
      const userId = await findTestUserId(db);
      await resetUserOnboardingState(db, userId);
      fixture = await seedProjectFixture(db, {
        userId,
        titlePrefix: "Onboarding gate e2e",
      });
      await markOnboardingCompleted(db, userId, fixture.projectId);
    } finally {
      await db.end();
    }

    if (!fixture) {
      throw new Error("seedProjectFixture did not return a fixture");
    }
    const projectFixture = fixture;

    await login(page);
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects\/[^/]+\/agent$/);
    await expect(page.getByTestId("project-shell")).toBeVisible();

    await page.goto("/onboarding");
    await expect(page).toHaveURL(new RegExp(`/projects/${projectFixture.projectId}/agent$`));

    const cleanupDb = openE2eDb(DATABASE_URL ?? "");
    try {
      await cleanupProjectFixture(cleanupDb, projectFixture);
      await resetUserOnboardingState(cleanupDb, await findTestUserId(cleanupDb));
    } finally {
      await cleanupDb.end();
    }
  });
});
