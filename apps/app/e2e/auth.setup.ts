import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { resolveAppUrl } from "./portless";

const APP_URL = resolveAppUrl();
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.STATE_PATH ?? resolve(HERE, "../.auth/state.json");

export async function authenticate(): Promise<string> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(`${APP_URL}/api/auth/dev-login`, { waitUntil: "domcontentloaded" });
    await page.waitForURL("**/auth-check", { timeout: 30_000 });
    await expect(page.getByTestId("auth-check-title")).toHaveText("Authenticated");
    await expect(page.getByTestId("auth-check-user")).not.toHaveText("");

    mkdirSync(dirname(STATE_PATH), { recursive: true });
    await context.storageState({ path: STATE_PATH });
    return STATE_PATH;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  authenticate()
    .then((path) => {
      console.log(`[auth.setup] storageState saved to ${path}`);
    })
    .catch((error) => {
      console.error("[auth.setup] failed:", error);
      process.exit(1);
    });
}
