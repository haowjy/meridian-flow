/**
 * Postgres regression for auth provisioning: one WorkOS principal maps to one
 * local account, while email collisions across principals fail closed.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { UserId } from "@meridian/contracts/runtime";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBootstrapRepository } from "./index.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("provisioning race (postgres)", () => {});
} else {
  describe("provisioning race (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { createDrizzleUserRepository } = await import("./adapters/user-repository/drizzle.js");
    const { AccountLinkConflictError } = await import("./ports/user-repository.js");
    const { provisionAuthenticatedUser } = await import("../../lib/auth.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");

    const db = createDb(DATABASE_URL, { max: 8 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const observer = postgres(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await control`SELECT pg_advisory_unlock_all()`;
      await truncateDrizzleTables(db, [schema.users]);
    });
    afterAll(async () => {
      await control.end();
      await observer.end();
      await db.close();
    });

    async function holdEmailAdmission(email: string): Promise<() => Promise<void>> {
      const admissionKey = `auth-email:${email}`;
      await control`SELECT pg_advisory_lock(hashtextextended(${admissionKey}, 0))`;
      return async () => {
        const [released] = await control<{ released: boolean }[]>`
          SELECT pg_advisory_unlock(hashtextextended(${admissionKey}, 0)) AS released
        `;
        if (!released?.released) throw new Error(`Did not hold the admission lock for ${email}`);
      };
    }

    async function waitForExactEmailAdmission(
      email: string,
      expectedWaiters: number,
      calls: Promise<unknown>[],
    ): Promise<number[]> {
      const admissionKey = `auth-email:${email}`;
      const settled = calls.map(() => false);
      for (const [index, call] of calls.entries()) {
        void call.then(
          () => {
            settled[index] = true;
          },
          () => {
            settled[index] = true;
          },
        );
      }

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiters = await observer<{ pid: number }[]>`
          SELECT locks.pid
          FROM pg_locks AS locks
          WHERE locks.locktype = 'advisory'
            AND locks.granted = false
            AND locks.database = (
              SELECT oid FROM pg_database WHERE datname = current_database()
            )
            AND locks.classid = (
              (hashtextextended(${admissionKey}, 0) >> 32) & 4294967295
            )::oid
            AND locks.objid = (
              hashtextextended(${admissionKey}, 0) & 4294967295
            )::oid
            AND locks.objsubid = 1
        `;
        if (waiters.length >= expectedWaiters) return waiters.map(({ pid }) => pid);
        if (settled.some(Boolean)) {
          throw new Error(
            "Provisioning completed before requesting the exact email admission lock",
          );
        }
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${expectedWaiters} exact email admission waiter(s)`);
    }

    it("admits same-principal provisioning through the exact email advisory key", async () => {
      const users = createDrizzleUserRepository({ db });
      const email = "race@example.com";
      const releaseAdmission = await holdEmailAdmission(email);
      const calls = [
        users.ensureUser({
          externalId: "user_workos_a",
          email,
          name: "A",
          avatarUrl: null,
        }),
        users.ensureUser({
          externalId: "user_workos_a",
          email,
          name: "B",
          avatarUrl: null,
        }),
      ];

      let admissionError: unknown;
      try {
        const waitingPids = await waitForExactEmailAdmission(email, 2, calls);
        expect(new Set(waitingPids).size).toBe(2);
        expect(await db.select().from(schema.users)).toHaveLength(0);
      } catch (error) {
        admissionError = error;
      } finally {
        await releaseAdmission();
      }

      const results = await Promise.allSettled(calls);
      if (admissionError) throw admissionError;

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);

      const rows = await db.select({ id: schema.users.id }).from(schema.users);
      expect(rows).toHaveLength(1);
      const returnedIds = new Set(results.map((r) => (r.status === "fulfilled" ? r.value : null)));
      expect(returnedIds).toEqual(new Set([rows[0]?.id]));
    });

    it("maps cross-principal overlap to 409 and bootstraps only the winner", async () => {
      const users = createDrizzleUserRepository({ db });
      const email = "race@example.com";
      const bootstrapUserIds: UserId[] = [];
      const projects = {
        async findPersonalProjectId() {
          return null;
        },
        async ensureDefaultBootstrapReady(userId: UserId) {
          bootstrapUserIds.push(userId);
          return true;
        },
        async ensureDefaultBootstrap() {
          throw new Error("Composition test must use only the auth readiness seam");
        },
      } satisfies ProjectBootstrapRepository;
      const inputs = [
        {
          externalId: "user_workos_a",
          email,
          name: "A",
          avatarUrl: null,
        },
        {
          externalId: "user_workos_b",
          email,
          name: "B",
          avatarUrl: null,
        },
      ];
      const releaseAdmission = await holdEmailAdmission(email);
      const calls = inputs.map((input) => provisionAuthenticatedUser(input, { users, projects }));

      let admissionError: unknown;
      try {
        const waitingPids = await waitForExactEmailAdmission(email, 2, calls);
        expect(new Set(waitingPids).size).toBe(2);
        expect(await db.select().from(schema.users)).toHaveLength(0);
        expect(bootstrapUserIds).toEqual([]);
      } catch (error) {
        admissionError = error;
      } finally {
        await releaseAdmission();
      }

      const results = await Promise.allSettled(calls);
      if (admissionError) throw admissionError;

      const [fulfilled] = results.filter((result) => result.status === "fulfilled");
      const [rejected] = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(rejected?.reason).toMatchObject({
        status: 409,
        data: { code: "account_link_conflict" },
      });
      expect(bootstrapUserIds).toEqual([fulfilled?.value]);

      const rows = await db
        .select({
          id: schema.users.id,
          externalId: schema.users.externalId,
          email: schema.users.email,
          name: schema.users.name,
        })
        .from(schema.users);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(fulfilled?.value);
      expect(rows[0]?.email).toBe("race@example.com");
      expect(inputs).toContainEqual({
        externalId: rows[0]?.externalId,
        email: rows[0]?.email,
        name: rows[0]?.name,
        avatarUrl: null,
      });
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
      expect(Object.getOwnPropertyNames(error).sort()).toEqual(["message", "name", "stack"]);
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
