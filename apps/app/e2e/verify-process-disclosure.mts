import { chromium, type Page } from "@playwright/test";
import { resolveAppUrl } from "./portless";

const APP_URL = resolveAppUrl();
const THREAD_ID = process.env.THREAD_ID;

type Check = { name: string; pass: boolean; detail: string };

async function login(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/api/auth/dev-login`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/auth-check", { timeout: 30_000 });
}

async function main(): Promise<void> {
  if (!THREAD_ID) {
    throw new Error("THREAD_ID is required for ProcessDisclosure verification");
  }

  const checks: Check[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await login(page);
    await page.goto(`${APP_URL}/chat/${THREAD_ID}`, { waitUntil: "networkidle", timeout: 60_000 });

    const thinkingButtons = page.getByRole("button", { name: /^Thinking$/i });
    const thinkingCount = await thinkingButtons.count();
    checks.push({
      name: "Settled turns with reasoning show ProcessDisclosure",
      pass: thinkingCount >= 1,
      detail: `found ${thinkingCount} Thinking disclosure trigger(s)`,
    });

    const firstThinking = thinkingButtons.first();
    const expandedBefore = await firstThinking.getAttribute("aria-expanded");
    await firstThinking.click();
    await page.waitForTimeout(400);
    const expandedAfter = await firstThinking.getAttribute("aria-expanded");
    checks.push({
      name: "ProcessDisclosure toggles on click",
      pass: expandedBefore !== expandedAfter && expandedAfter === "true",
      detail: `aria-expanded ${expandedBefore} → ${expandedAfter}`,
    });

    console.log("\n=== ProcessDisclosure browser verification ===\n");
    let failed = 0;
    for (const check of checks) {
      const mark = check.pass ? "PASS" : "FAIL";
      if (!check.pass) failed += 1;
      console.log(`${mark}  ${check.name}`);
      console.log(`      ${check.detail}\n`);
    }
    if (failed > 0) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
