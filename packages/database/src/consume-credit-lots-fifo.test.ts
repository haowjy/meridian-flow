import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const testUserId = process.env.TEST_USER_ID;

function assertSafeTestDatabase(): void {
  if (!databaseUrl) {
    return;
  }
  if (process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") {
    return;
  }
  if (!databaseUrl.includes("127.0.0.1:54422")) {
    throw new Error(
      "Refusing billing tests: DATABASE_URL must be local Supabase (127.0.0.1:54422) or set TEST_DB_ALLOW_DESTRUCTIVE=1",
    );
  }
}

describe.skipIf(!databaseUrl || !testUserId)("consume_credit_lots_fifo", () => {
  it("debits FIFO, is idempotent, and can go negative via debt lot", async () => {
    assertSafeTestDatabase();
    const sql = postgres(databaseUrl!, { max: 1 });
    const userId = testUserId!;
    const groupId = randomUUID();
    const usageEventId = `test-${randomUUID()}`;

    try {
      await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM credit_lots WHERE user_id = ${userId}::uuid`;

      const grantA = randomUUID();
      const grantB = randomUUID();
      const now = new Date();
      const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO credit_lots (id, user_id, source_type, original_amount_millicredits, remaining_millicredits, grant_reason, expires_at)
        VALUES
          (${grantA}::uuid, ${userId}::uuid, 'grant', 5000, 5000, 'signup', ${soon}),
          (${grantB}::uuid, ${userId}::uuid, 'grant', 3000, 3000, 'monthly_2026_05', ${later})
      `;

      const first = await sql<{ remaining_balance: string; went_negative: boolean }[]>`
        SELECT * FROM consume_credit_lots_fifo(
          ${userId}::uuid,
          ${6000}::bigint,
          ${groupId}::uuid,
          ${usageEventId},
          '{}'::jsonb
        )
      `;

      expect(first[0]?.went_negative).toBe(false);
      expect(Number(first[0]?.remaining_balance)).toBe(2000);

      const txRows = await sql<{ usage_event_id: string | null; count: string }[]>`
        SELECT usage_event_id, COUNT(*)::text AS count
        FROM credit_transactions
        WHERE user_id = ${userId}::uuid
          AND transaction_type = 'consumption'
          AND consumption_group_id = ${groupId}::uuid
        GROUP BY usage_event_id
      `;
      expect(txRows).toHaveLength(1);
      expect(txRows[0]?.usage_event_id).toBe(usageEventId);
      expect(Number(txRows[0]?.count)).toBe(2);

      const lotsAfter = await sql<
        { grant_reason: string | null; remaining_millicredits: string }[]
      >`
        SELECT grant_reason, remaining_millicredits
        FROM credit_lots
        WHERE user_id = ${userId}::uuid
        ORDER BY grant_reason NULLS LAST
      `;

      const signupLot = lotsAfter.find((l) => l.grant_reason === "signup");
      const monthlyLot = lotsAfter.find((l) => l.grant_reason === "monthly_2026_05");
      expect(Number(signupLot?.remaining_millicredits)).toBe(0);
      expect(Number(monthlyLot?.remaining_millicredits)).toBe(2000);

      const second = await sql<{ remaining_balance: string; went_negative: boolean }[]>`
        SELECT * FROM consume_credit_lots_fifo(
          ${userId}::uuid,
          ${6000}::bigint,
          ${groupId}::uuid,
          ${usageEventId},
          '{}'::jsonb
        )
      `;

      expect(Number(second[0]?.remaining_balance)).toBe(Number(first[0]?.remaining_balance));
      expect(second[0]?.went_negative).toBe(false);

      const third = await sql<{ remaining_balance: string; went_negative: boolean }[]>`
        SELECT * FROM consume_credit_lots_fifo(
          ${userId}::uuid,
          ${5000}::bigint,
          ${randomUUID()}::uuid,
          ${`test-${randomUUID()}`},
          '{}'::jsonb
        )
      `;

      expect(third[0]?.went_negative).toBe(true);
      expect(Number(third[0]?.remaining_balance)).toBeLessThan(0);

      const debtLots = await sql<{ source_type: string }[]>`
        SELECT source_type FROM credit_lots
        WHERE user_id = ${userId}::uuid AND source_type = 'debt'
      `;
      expect(debtLots.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM credit_lots WHERE user_id = ${userId}::uuid`;
      await sql.end();
    }
  });

  it("creates debt lot on overspend when user has no lots", async () => {
    assertSafeTestDatabase();
    const sql = postgres(databaseUrl!, { max: 1 });
    const userId = testUserId!;

    try {
      await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM credit_lots WHERE user_id = ${userId}::uuid`;

      await sql`
        SELECT * FROM consume_credit_lots_fifo(
          ${userId}::uuid,
          ${1000}::bigint,
          ${randomUUID()}::uuid,
          ${`test-${randomUUID()}`},
          '{}'::jsonb
        )
      `;

      const lots = await sql<{ source_type: string; grant_reason: string | null }[]>`
        SELECT source_type, grant_reason FROM credit_lots WHERE user_id = ${userId}::uuid
      `;
      expect(lots).toHaveLength(1);
      expect(lots[0]?.source_type).toBe("debt");
      expect(lots[0]?.grant_reason).toBeNull();
    } finally {
      await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM credit_lots WHERE user_id = ${userId}::uuid`;
      await sql.end();
    }
  });

  it("debits expiring grant before non-expiring purchase", async () => {
    assertSafeTestDatabase();
    const sql = postgres(databaseUrl!, { max: 1 });
    const userId = testUserId!;
    const usageEventId = `test-${randomUUID()}`;

    try {
      await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM credit_lots WHERE user_id = ${userId}::uuid`;

      const grantId = randomUUID();
      const purchaseId = randomUUID();
      const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO credit_lots (id, user_id, source_type, original_amount_millicredits, remaining_millicredits, grant_reason, expires_at)
        VALUES (${grantId}::uuid, ${userId}::uuid, 'grant', 5000, 5000, 'signup', ${soon})
      `;
      await sql`
        INSERT INTO credit_lots (id, user_id, source_type, original_amount_millicredits, remaining_millicredits)
        VALUES (${purchaseId}::uuid, ${userId}::uuid, 'purchase', 3000, 3000)
      `;

      await sql`
        SELECT * FROM consume_credit_lots_fifo(
          ${userId}::uuid,
          ${6000}::bigint,
          ${randomUUID()}::uuid,
          ${usageEventId},
          '{}'::jsonb
        )
      `;

      const grantRemaining = await sql<{ remaining_millicredits: string }[]>`
        SELECT remaining_millicredits FROM credit_lots WHERE id = ${grantId}::uuid
      `;
      const purchaseRemaining = await sql<{ remaining_millicredits: string }[]>`
        SELECT remaining_millicredits FROM credit_lots WHERE id = ${purchaseId}::uuid
      `;
      expect(Number(grantRemaining[0]?.remaining_millicredits)).toBe(0);
      expect(Number(purchaseRemaining[0]?.remaining_millicredits)).toBe(2000);
    } finally {
      await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM credit_lots WHERE user_id = ${userId}::uuid`;
      await sql.end();
    }
  });

  it("rejects null or empty usage_event_id", async () => {
    assertSafeTestDatabase();
    const sql = postgres(databaseUrl!, { max: 1 });
    const userId = testUserId!;

    try {
      await expect(
        sql`
          SELECT * FROM consume_credit_lots_fifo(
            ${userId}::uuid,
            ${100}::bigint,
            ${randomUUID()}::uuid,
            NULL,
            '{}'::jsonb
          )
        `,
      ).rejects.toThrow(/usage_event_id is required/);

      await expect(
        sql`
          SELECT * FROM consume_credit_lots_fifo(
            ${userId}::uuid,
            ${100}::bigint,
            ${randomUUID()}::uuid,
            ${"   "},
            '{}'::jsonb
          )
        `,
      ).rejects.toThrow(/usage_event_id is required/);
    } finally {
      await sql.end();
    }
  });
});
