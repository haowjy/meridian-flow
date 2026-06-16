import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  cleanupProjectFixture,
  type Db,
  findTestUserId,
  login,
  openE2eDb,
  type ProjectFixture,
  seedProjectFixture,
} from "./support/e2e-db";

const TURN_COUNT = Number(process.env.CHAT_SMOKE_TURNS ?? "200");
const MAX_SETTLED_DOM_ROWS = Number(process.env.CHAT_SMOKE_MAX_SETTLED_ROWS ?? "40");
const MAX_TOTAL_DOM_NODES = Number(process.env.CHAT_SMOKE_MAX_DOM_NODES ?? "250");
const DATABASE_URL = process.env.CHAT_SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;

test("large chat keeps settled history virtualized", async ({ page }) => {
  test.skip(!DATABASE_URL, "CHAT_SMOKE_DATABASE_URL or DATABASE_URL is required");

  await login(page);
  const db = openE2eDb(DATABASE_URL ?? "");
  const fixture = await seedProjectFixture(db, {
    userId: await findTestUserId(db),
    titlePrefix: "Chat performance smoke",
  });

  try {
    await seedChatTurns(db, fixture, TURN_COUNT);
    await page.goto(`/chat/${fixture.threadId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();

    const virtualList = page.locator("[data-chat-virtual-list]");
    await expect(virtualList).toHaveAttribute("data-settled-turn-count", String(TURN_COUNT));

    const metrics = await page.evaluate(() => {
      const scrollOwners = Array.from(document.querySelectorAll<HTMLElement>('[role="log"]'));
      const chatScrollOwners = scrollOwners.filter((element) =>
        element.classList.contains("overflow-y-auto"),
      );
      const virtualList = document.querySelector<HTMLElement>("[data-chat-virtual-list]");
      const scrollOwner = chatScrollOwners[0] ?? null;

      return {
        settledRows: document.querySelectorAll('[data-chat-turn-row="settled"]').length,
        liveRows: document.querySelectorAll('[data-chat-turn-row="live"]').length,
        totalDomNodes: document.querySelectorAll("*").length,
        scrollOwnerCount: chatScrollOwners.length,
        virtualizedTurnCount: virtualList?.dataset.settledTurnCount ?? null,
        scrollHeight: scrollOwner?.scrollHeight ?? 0,
        clientHeight: scrollOwner?.clientHeight ?? 0,
      };
    });

    expect(metrics.scrollOwnerCount).toBe(1);
    expect(metrics.virtualizedTurnCount).toBe(String(TURN_COUNT));
    expect(metrics.liveRows).toBe(0);
    expect(metrics.settledRows).toBeLessThanOrEqual(MAX_SETTLED_DOM_ROWS);
    expect(metrics.totalDomNodes).toBeLessThanOrEqual(MAX_TOTAL_DOM_NODES);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  } finally {
    await cleanupProjectFixture(db, fixture).finally(() => db.end());
  }
});

async function seedChatTurns(db: Db, fixture: ProjectFixture, turnCount: number): Promise<void> {
  const now = Date.now();
  let previousTurnId: string | null = null;

  await db.begin(async (tx) => {
    for (let index = 0; index < turnCount; index++) {
      const turnId = randomUUID();
      const blockId = randomUUID();
      const role = index % 2 === 0 ? "user" : "assistant";
      const turnNumber = index + 1;
      const text =
        role === "user"
          ? `Synthetic user request ${turnNumber}. Please keep this short but realistic.`
          : `Synthetic assistant answer ${turnNumber}. This settled answer has representative markdown text for row measurement.`;
      const createdAt = new Date(now + index * 1000);

      await tx`
        INSERT INTO turns (id, thread_id, parent_turn_id, role, status, finish_reason, created_at, completed_at)
        VALUES (${turnId}, ${fixture.threadId}, ${previousTurnId}, ${role}, 'complete', ${role === "assistant" ? "end_turn" : null}, ${createdAt}, ${createdAt})
      `;
      await tx`
        INSERT INTO turn_blocks (id, turn_id, block_type, sequence, content, model_text, compact, status, created_at)
        VALUES (${blockId}, ${turnId}, 'text', 0, ${JSON.stringify({ text })}::jsonb, ${text}, ${text}, 'complete', ${createdAt})
      `;
      previousTurnId = turnId;
    }

    await tx`
      UPDATE threads
      SET turn_count = ${turnCount}, updated_at = now()
      WHERE id = ${fixture.threadId}
    `;
  });
}
