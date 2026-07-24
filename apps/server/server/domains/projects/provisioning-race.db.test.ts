/**
 * Postgres regression for #329: concurrent user provisioning of the same email
 * must converge on one account instead of leaking a `users_email_unique`
 * duplicate-key 500 to the app error boundary. `onConflictDoUpdate` arbitrates
 * only external_id, so a same-email/different-external-id race slips past it.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("provisioning race (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("provisioning race (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { createDrizzleUserRepository } = await import("./adapters/user-repository/drizzle.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");

    const db = createDb(DATABASE_URL, { max: 8 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
    });
    afterAll(async () => db.$client.end());

    it("same-email provisioning under different external ids converges to one account", async () => {
      const users = createDrizzleUserRepository({ db });
      const results = await Promise.allSettled([
        users.ensureUser({
          externalId: "user_workos_a",
          email: "race@example.com",
          name: "A",
          avatarUrl: null,
        }),
        users.ensureUser({
          externalId: "user_workos_b",
          email: "race@example.com",
          name: "B",
          avatarUrl: null,
        }),
      ]);

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);

      const rows = await db.select({ id: schema.users.id }).from(schema.users);
      expect(rows).toHaveLength(1);
      const returnedIds = new Set(results.map((r) => (r.status === "fulfilled" ? r.value : null)));
      expect(returnedIds).toEqual(new Set([rows[0]?.id]));
    });

    it("re-provisioning an existing identity refreshes profile without a dup-key", async () => {
      const users = createDrizzleUserRepository({ db });
      const first = await users.ensureUser({
        externalId: "user_workos_c",
        email: "stable@example.com",
        name: "Old",
        avatarUrl: null,
      });
      const second = await users.ensureUser({
        externalId: "user_workos_c",
        email: "stable@example.com",
        name: "New",
        avatarUrl: "https://cdn/a.png",
      });
      expect(second).toBe(first);
      const [row] = await db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, first as never));
      expect(row?.name).toBe("New");
    });
  });
}
