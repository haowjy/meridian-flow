import { randomUUID } from "node:crypto";
import { type CDPSession, expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  findTestUserId,
  login,
  openE2eDb,
  type ProjectFixture,
  seedProjectFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.DATABASE_URL;
const LONG_LABEL = "Localized composer control label ".repeat(12);
const LONG_VALUE = "Localized current selection value ".repeat(12);

test("compact root preserves text lanes and follows the document safe area", async ({
  context,
  page,
}) => {
  test.skip(!DATABASE_URL, "DATABASE_URL is required");
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page);
  const db = openE2eDb(DATABASE_URL ?? "");
  let fixture: ProjectFixture | undefined;

  try {
    fixture = await seedProjectFixture(db, page.request, {
      userId: await findTestUserId(db),
      titlePrefix: "Composer density",
    });
    const { threadId } = fixture;
    const turnId = randomUUID();
    const blockId = randomUUID();
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO turns (id, thread_id, parent_turn_id, role, status, finish_reason, created_at, completed_at)
        VALUES (${turnId}, ${threadId}, NULL, 'user', 'complete', NULL, now(), now())
      `;
      await tx`
        INSERT INTO turn_blocks (id, turn_id, block_type, sequence, content, model_text, compact, status, created_at)
        VALUES (${blockId}, ${turnId}, 'text', 0, ${JSON.stringify({ text: "Started thread" })}::jsonb, 'Started thread', 'Started thread', 'complete', now())
      `;
      await tx`
        UPDATE threads SET turn_count = 1, updated_at = now() WHERE id = ${threadId}
      `;
    });

    await page.goto(`/project/${fixture.projectId}?thread=${threadId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.setViewportSize({ width: 240, height: 800 });
    await page.getByRole("group", { name: "Composer controls" }).evaluate((node) => {
      node.style.width = "44px";
      node.style.flex = "0 0 44px";
    });
    await page
      .locator('span[aria-hidden="true"]:has(button[aria-label="Agent: General"])')
      .waitFor({ state: "attached" });
    await page
      .getByRole("button", { name: "More composer controls" })
      .evaluate((button: HTMLButtonElement) => button.click());

    const root = page.getByRole("dialog", { name: "More composer controls" });
    const actionable = root.locator('button:has(> [data-slot="composer-root-row-label"])');
    const status = root.locator('div:has(> [data-slot="composer-root-row-label"])');
    await expect(actionable.first()).toBeVisible();
    await expect(status.first()).toBeVisible();

    const cdp = await context.newCDPSession(page);
    const content = root;
    await page.setViewportSize({ width: 400, height: 800 });
    await expectPopoverInside(content, { top: 0, right: 0, bottom: 0, left: 0 });

    await setSafeAreaInsets(cdp, { top: 24, right: 7, bottom: 34, left: 18 });
    await expectPopoverInside(content, { top: 24, right: 7, bottom: 34, left: 18 });

    // Keep the surface open while both viewport orientation and asymmetric CSS
    // safe-area geometry change. Floating UI's supported resize lifecycle must
    // remeasure the document boundary rather than retaining the first placement.
    await page.setViewportSize({ width: 800, height: 400 });
    await setSafeAreaInsets(cdp, { top: 9, right: 31, bottom: 12, left: 43 });
    await expectPopoverInside(content, { top: 9, right: 31, bottom: 12, left: 43 });

    for (const row of [actionable.first(), status.first()]) {
      await row.locator('[data-slot="composer-root-row-label"]').evaluate((node, text) => {
        node.textContent = text;
      }, LONG_LABEL);
      await row.locator('[data-slot="composer-root-row-value"]').evaluate((node, text) => {
        node.textContent = text;
      }, LONG_VALUE);
      await expect(row.locator('[data-slot="composer-root-row-label"]')).toHaveText(LONG_LABEL);
      await expect(row.locator('[data-slot="composer-root-row-value"]')).toHaveText(LONG_VALUE);

      const geometry = await row.evaluate((node) => {
        const label = node.querySelector<HTMLElement>('[data-slot="composer-root-row-label"]');
        const value = node.querySelector<HTMLElement>('[data-slot="composer-root-row-value"]');
        if (!label || !value) throw new Error("root row text lanes are missing");
        return {
          rowClientWidth: node.clientWidth,
          rowScrollWidth: node.scrollWidth,
          labelClientWidth: label.clientWidth,
          labelScrollWidth: label.scrollWidth,
          labelOverflow: getComputedStyle(label).overflow,
          valueClientWidth: value.clientWidth,
          valueScrollWidth: value.scrollWidth,
          valueOverflow: getComputedStyle(value).overflow,
        };
      });

      expect(geometry.rowScrollWidth).toBeLessThanOrEqual(geometry.rowClientWidth);
      expect(geometry.labelClientWidth).toBeGreaterThan(0);
      expect(geometry.valueClientWidth).toBeGreaterThan(0);
      expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelClientWidth);
      expect(geometry.valueScrollWidth).toBeGreaterThan(geometry.valueClientWidth);
      expect(geometry.labelOverflow).toBe("hidden");
      expect(geometry.valueOverflow).toBe("hidden");
    }
  } finally {
    await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
      db.end(),
    );
  }
});

type Insets = { top: number; right: number; bottom: number; left: number };

async function setSafeAreaInsets(cdp: CDPSession, insets: Insets) {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: {
      ...insets,
      topMax: insets.top,
      rightMax: insets.right,
      bottomMax: insets.bottom,
      leftMax: insets.left,
    },
  });
}

async function expectPopoverInside(content: import("@playwright/test").Locator, insets: Insets) {
  await expect
    .poll(async () => {
      const box = await content.boundingBox();
      if (!box) return null;
      const viewport = await content.evaluate(() => ({
        left: window.visualViewport?.offsetLeft ?? 0,
        top: window.visualViewport?.offsetTop ?? 0,
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
      }));
      const gutters = {
        left: box.x - viewport.left - insets.left,
        top: box.y - viewport.top - insets.top,
        right: viewport.left + viewport.width - insets.right - box.x - box.width,
        bottom: viewport.top + viewport.height - insets.bottom - box.y - box.height,
      };
      return Math.min(...Object.values(gutters));
    })
    .toBeGreaterThanOrEqual(8);
}
