/** PostgreSQL proof for ahead registration, the namespace race with arrival, and settlement CAS. */
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
import {
  contextNamespaceKey,
  lockContextSources,
  lockNamespaceKeys,
} from "./context-fs/document-locations.js";
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
    const NO_WORK = "00000000-0000-4000-8000-000000000b08";
    const DOCUMENT_2 = "00000000-0000-4000-8000-000000000b0a";
    const SOURCES = {
      manuscript: SOURCE,
      scratch: "00000000-0000-4000-8000-000000000b0b",
    } as const;
    type Scheme = keyof typeof SOURCES;
    const addressFor = (scheme: Scheme) =>
      scheme === "manuscript" ? "manuscript://chapter.md" : `${scheme}://@/chapter.md`;
    const registrationFor = (scheme: Scheme, aheadId = AHEAD) => ({
      aheadId,
      holderProjectId: PROJECT as never,
      address: addressFor(scheme),
    });
    const registration = registrationFor("manuscript");
    // Controlled manifest membership: tests decide which SQL rows are live.
    let liveMembers: string[] = [];
    const membership = async () => ({ members: liveMembers });
    // Registration commits in its own root transaction, so no rollback fixture: reset by FK order.
    const database = createDb(DATABASE_URL, { max: 4 });
    const arrivalConnection = createDb(DATABASE_URL, { max: 2 });
    const gateConnection = createDb(DATABASE_URL, { max: 2 });

    async function seed() {
      liveMembers = [DOCUMENT, DOCUMENT_2];
      await deleteDrizzleRows(database, [users]);
      await database.insert(users).values(conformanceUserValues(USER, "ahead-registry"));
      await database
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Ahead Project", slug: "ahead-project" });
      await database.insert(works).values({
        id: NO_WORK,
        projectId: PROJECT,
        createdByUserId: USER,
        name: "No Work",
        slug: null,
        isNoWork: true,
      });
      await database
        .insert(contextSources)
        .values({ id: SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript" });
      for (const scheme of ["scratch"] as const) {
        await database.insert(contextSources).values({
          id: SOURCES[scheme],
          workId: NO_WORK,
          scope: "work",
          name: scheme,
          slug: scheme,
        });
      }
    }
    const insertDocument = (db: Database, scheme: Scheme = "manuscript", id = DOCUMENT) =>
      db
        .insert(documents)
        .values({ id, contextSourceId: SOURCES[scheme], name: "chapter", extension: "md" });
    const settledIds = async () =>
      (await database.select({ id: linkAheadRefs.settledDocumentId }).from(linkAheadRefs)).map(
        (row) => row.id,
      );
    const newRegistry = (db: Database) => createDrizzleLinkAheadRegistry(db, membership);

    /** The exact key real arrivals take for this scheme's source (No Work: the persisted row id). */
    const arrivalKey = (scheme: Scheme) =>
      contextNamespaceKey({
        projectId: PROJECT,
        userId: USER,
        scheme,
        workId: scheme === "manuscript" ? null : NO_WORK,
      });

    /** Number of sessions blocked on exactly this namespace key in this database. */
    async function waitersOn(key: string) {
      const rows = await database.execute<{ waiting: number }>(sql`
        SELECT count(*)::int AS waiting FROM pg_locks l
        WHERE l.locktype = 'advisory' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${key}, 0::bigint)`);
      return rows[0]?.waiting ?? 0;
    }
    async function waitForWaiters(key: string, count: number) {
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await waitersOn(key)) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`expected ${count} session(s) queued behind ${key}`);
    }

    /** Real arrival: source lock, insert, settle, in the arrival connection's transaction. */
    const arrive = (scheme: Scheme, id = DOCUMENT, before?: () => Promise<void>) =>
      runInDrizzleTransaction(arrivalConnection, async () => {
        await lockContextSources(arrivalConnection, [SOURCES[scheme]]);
        await insertDocument(arrivalConnection, scheme, id);
        await before?.();
        return newRegistry(arrivalConnection).settleArrivals([id as never]);
      });

    beforeEach(seed);
    afterAll(async () => {
      await deleteDrizzleRows(database, [users]);
      await gateConnection.close();
      await arrivalConnection.close();
      await database.close();
    });

    /** Arrival holds its key; registration queues on the same key and sees the document. */
    async function raceArrivalFirst(scheme: Scheme) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const arrival = arrive(scheme, DOCUMENT, async () => {
        locked();
        await held;
      });
      try {
        await lockTaken;
        const registering = newRegistry(database).register([registrationFor(scheme)]);
        await waitForWaiters(arrivalKey(scheme), 1);
        release();
        const [arrivalSettled] = await Promise.all([arrival, registering]);
        expect(arrivalSettled).toBe(0); // the row did not exist yet; registration saw the document
        expect(await settledIds()).toEqual([DOCUMENT]);
      } finally {
        release();
        await arrival.catch(() => undefined);
      }
    }

    /** Registration queues ahead of the arrival, then the arrival's CAS settles it. */
    async function raceRegistrationFirst(scheme: Scheme) {
      // The gate holds the key so registration and then the arrival queue in a known order.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const gateTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = runInDrizzleTransaction(gateConnection, async () => {
        // Namespace key only: a Work-row lock would queue the arrival on the row, not the key.
        await lockNamespaceKeys(gateConnection, [
          {
            projectId: PROJECT,
            userId: USER,
            scheme,
            workId: scheme === "manuscript" ? null : NO_WORK,
          },
        ]);
        locked();
        await held;
      });
      // The arrival stops after its insert, before settling, so the unsettled row is observable.
      let settle!: () => void;
      const settling = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let inserted!: () => void;
      const arrivalInserted = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      let registering: Promise<void> | undefined;
      let arrival: Promise<number> | undefined;
      try {
        await gateTaken;
        registering = newRegistry(database).register([registrationFor(scheme)]);
        await waitForWaiters(arrivalKey(scheme), 1);
        arrival = arrive(scheme, DOCUMENT, async () => {
          inserted();
          await settling;
        });
        await waitForWaiters(arrivalKey(scheme), 2);
        release();
        await registering;
        await arrivalInserted;
        expect(await settledIds()).toEqual([null]); // committed before the document existed
        settle();
        expect(await arrival).toBe(1);
        expect(await settledIds()).toEqual([DOCUMENT]);
      } finally {
        release();
        settle();
        await Promise.allSettled([gate, registering, arrival]);
      }
    }

    it("manuscript namespace race settles exactly once in both orders", async () => {
      await raceArrivalFirst("manuscript");
      await seed();
      await raceRegistrationFirst("manuscript");
    });

    // Only the namespace key differs by scheme: scratch and uploads take the same No Work key
    // shape and neither is drafted, so one scratch arrival proves registration locks that key.
    it("scratch registration queues on the No Work key its arrival holds", async () => {
      await raceArrivalFirst("scratch");
    });

    it("settles an occupied address at registration, once: later occupants and re-registration never retarget", async () => {
      await insertDocument(database);
      const registry = newRegistry(database);
      await registry.register([registration]);
      expect(await settledIds()).toEqual([DOCUMENT]);
      const [first] = await database.select().from(linkAheadRefs);

      // Delete and recreate the address: the compare-and-set must not move the target.
      await database
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOCUMENT));
      await insertDocument(database, "manuscript", DOCUMENT_2);
      expect(await registry.settleArrivals([DOCUMENT_2 as never])).toBe(0);
      await registry.register([registration]);
      const [after] = await database.select().from(linkAheadRefs);
      expect(after?.settledDocumentId).toBe(DOCUMENT);
      expect(after?.settledAt).toEqual(first?.settledAt);

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

    it("normalizes ahead ids and requires an exact qualified address", async () => {
      const registry = newRegistry(database);
      await insertDocument(database);
      await registry.register([{ ...registration, aheadId: AHEAD.toUpperCase() }]);
      expect(await database.select().from(linkAheadRefs)).toEqual([
        expect.objectContaining({ aheadId: AHEAD, settledDocumentId: DOCUMENT }),
      ]);
      await registry.register([{ ...registration, aheadId: AHEAD.toUpperCase() }]); // idempotent

      for (const address of [
        "scratch://@/trailing.",
        "scratch://@/.hidden",
        "scratch://@/noext",
        "scratch://contextual.md",
      ]) {
        await expect(
          registry.register([{ ...registration, aheadId: DOCUMENT_2, address }]),
        ).rejects.toBeInstanceOf(RangeError);
      }
      expect(await database.select().from(linkAheadRefs)).toHaveLength(1);

      // A valid address past PostgreSQL's B-tree tuple limit registers and is found exactly.
      let seed = 913;
      const segment = () =>
        Array.from({ length: 90 }, () => {
          seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
          return String.fromCharCode(0x4e00 + (seed % 18_000));
        }).join("");
      const long = `manuscript://${Array.from({ length: 18 }, segment).join("/")}.md`;
      const longRegistration = { ...registration, aheadId: DOCUMENT_2, address: long };
      await expect.soft(registry.register([longRegistration])).resolves.toBeUndefined();
      await expect.soft(registry.register([longRegistration])).resolves.toBeUndefined();
      expect
        .soft(
          (
            await database
              .select({ path: linkAheadRefs.path, settled: linkAheadRefs.settledDocumentId })
              .from(linkAheadRefs)
              .where(eq(linkAheadRefs.aheadId, DOCUMENT_2))
          ).map((row) => [`manuscript://${row.path}`, row.settled]),
        )
        .toEqual([[long, null]]);
    });
  });
}
