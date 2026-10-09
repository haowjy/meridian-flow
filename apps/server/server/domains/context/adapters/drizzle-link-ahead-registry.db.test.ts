/** PostgreSQL proof for ahead registration, the namespace race with arrival, and settlement CAS. */
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
import { lockNamespaceKeys } from "./context-fs/document-locations.js";
import { createDrizzleLinkAheadRegistry } from "./drizzle-link-ahead-registry.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN =
  (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") && DATABASE_URL;

if (!RUN) {
  describe.skip("ahead-ref registry (postgres)", () => {});
} else {
  describe("ahead-ref registry (postgres)", () => {
    const USER = "00000000-0000-4000-8000-000000000b01";
    const PROJECT = "00000000-0000-4000-8000-000000000b02";
    const SOURCE = "00000000-0000-4000-8000-000000000b03";
    const DOCUMENT = "00000000-0000-4000-8000-000000000b04";
    const AHEAD = "00000000-0000-4000-8000-000000000b05";
    const registration = {
      aheadId: AHEAD,
      holderProjectId: PROJECT as never,
      address: "manuscript://chapter.md",
    };
    const NAMESPACE = [{ projectId: PROJECT, userId: USER, scheme: "manuscript", workId: null }];
    // Registration commits in its own root transaction, so no rollback fixture: reset by FK order.
    const database = createDb(DATABASE_URL, { max: 4 });
    const arrivalConnection = createDb(DATABASE_URL, { max: 2 });

    async function seed() {
      await deleteDrizzleRows(database, [users]);
      await database.insert(users).values(conformanceUserValues(USER, "ahead-registry"));
      await database
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Ahead Project", slug: "ahead-project" });
      await database
        .insert(contextSources)
        .values({ id: SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript" });
    }
    const insertDocument = (db: Database) =>
      db
        .insert(documents)
        .values({ id: DOCUMENT, contextSourceId: SOURCE, name: "chapter", extension: "md" });
    const settledIds = async () =>
      (await database.select({ id: linkAheadRefs.settledDocumentId }).from(linkAheadRefs)).map(
        (row) => row.id,
      );

    /** Proves registration is queued behind the arrival's namespace key, not merely slow. */
    async function waitForBlockedAdvisoryLock() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await database.execute<{ waiting: number }>(
          sql`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if (rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("registration never queued behind the namespace lock");
    }

    beforeEach(seed);
    afterAll(async () => {
      await deleteDrizzleRows(database, [users]);
      await arrivalConnection.close();
      await database.close();
    });

    it("registration racing arrival settles exactly once in both orders", async () => {
      const registry = createDrizzleLinkAheadRegistry(database);
      const arrivalRegistry = createDrizzleLinkAheadRegistry(arrivalConnection);

      // Arrival first: it holds the namespace while registration waits behind it.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const arrival = runInDrizzleTransaction(arrivalConnection, async () => {
        await lockNamespaceKeys(arrivalConnection, NAMESPACE);
        await insertDocument(arrivalConnection);
        locked();
        await held;
        return arrivalRegistry.settleArrivals([DOCUMENT as never]);
      });
      await lockTaken;
      const registering = registry.register([registration]);
      await waitForBlockedAdvisoryLock();
      release();
      const [arrivalSettled] = await Promise.all([arrival, registering]);
      expect(arrivalSettled).toBe(0); // the row did not exist yet; registration saw the document
      expect(await settledIds()).toEqual([DOCUMENT]);

      // Registration first: it commits unsettled; the arrival's compare-and-set settles it.
      await seed();
      await registry.register([registration]);
      expect(await settledIds()).toEqual([null]);
      const arrived = await runInDrizzleTransaction(arrivalConnection, async () => {
        await lockNamespaceKeys(arrivalConnection, NAMESPACE);
        await insertDocument(arrivalConnection);
        return arrivalRegistry.settleArrivals([DOCUMENT as never]);
      });
      expect(arrived).toBe(1);
      expect(await settledIds()).toEqual([DOCUMENT]);
    });

    it("settles an occupied address at registration, keeps an orphan, rejects reuse, and guards transactions", async () => {
      await insertDocument(database);
      const registry = createDrizzleLinkAheadRegistry(database);
      await registry.register([registration]);
      expect(await settledIds()).toEqual([DOCUMENT]);

      await expect(
        registry.register([{ ...registration, address: "manuscript://other.md" }]),
      ).rejects.toThrow(/another address/);

      // Registration commits first, so a caller that then rolls back leaves a harmless orphan row.
      const orphan = { ...registration, aheadId: "00000000-0000-4000-8000-000000000b06" };
      await registry.register([orphan]);
      await expect(
        runInDrizzleTransaction(database, async () => {
          throw new Error("caller rolls back");
        }),
      ).rejects.toThrow("caller rolls back");
      expect(await database.select().from(linkAheadRefs)).toHaveLength(2);

      // Inside the caller's transaction the guard throws before anything is written.
      const inside = { ...registration, aheadId: "00000000-0000-4000-8000-000000000b07" };
      await expect(
        runInDrizzleTransaction(database, () => registry.register([inside])),
      ).rejects.toBeInstanceOf(RegistrationInsideTransactionError);
      expect(await database.select().from(linkAheadRefs)).toHaveLength(2);
    });
  });
}
