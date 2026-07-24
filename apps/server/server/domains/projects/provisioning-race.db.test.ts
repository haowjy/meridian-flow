/**
 * Postgres regression for auth provisioning: one WorkOS principal maps to one
 * local account, while email collisions across principals fail closed.
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
    const { AccountLinkConflictError } = await import("./ports/user-repository.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");

    const db = createDb(DATABASE_URL, { max: 8 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
    });
    afterAll(async () => db.$client.end());

    it("concurrent provisioning for the same external id converges to one account", async () => {
      const users = createDrizzleUserRepository({ db });
      const results = await Promise.allSettled([
        users.ensureUser({
          externalId: "user_workos_a",
          email: "race@example.com",
          name: "A",
          avatarUrl: null,
        }),
        users.ensureUser({
          externalId: "user_workos_a",
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

    it("rejects an email collision across external ids without exposing or mutating either row", async () => {
      const users = createDrizzleUserRepository({ db });
      const existingId = await users.ensureUser({
        externalId: "user_workos_a",
        email: "claimed@example.com",
        name: "Existing User",
        avatarUrl: "https://cdn/existing.png",
      });
      const conflictingId = await users.ensureUser({
        externalId: "user_workos_b",
        email: "other@example.com",
        name: "Conflicting User",
        avatarUrl: "https://cdn/conflicting.png",
      });

      const collision = users.ensureUser({
        externalId: "user_workos_b",
        email: "claimed@example.com",
        name: "Replacement Profile",
        avatarUrl: "https://cdn/replacement.png",
      });
      const error = await collision.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AccountLinkConflictError);
      expect(String(error)).not.toContain(existingId);
      expect(String(error)).not.toContain(conflictingId);
      expect(String(error)).not.toContain("user_workos_a");
      expect(String(error)).not.toContain("user_workos_b");

      const rows = await db
        .select({
          id: schema.users.id,
          externalId: schema.users.externalId,
          email: schema.users.email,
          name: schema.users.name,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.users);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            id: existingId,
            externalId: "user_workos_a",
            email: "claimed@example.com",
            name: "Existing User",
            avatarUrl: "https://cdn/existing.png",
          },
          {
            id: conflictingId,
            externalId: "user_workos_b",
            email: "other@example.com",
            name: "Conflicting User",
            avatarUrl: "https://cdn/conflicting.png",
          },
        ]),
      );
    });

    it("re-provisioning an existing user refreshes the mutable profile", async () => {
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
