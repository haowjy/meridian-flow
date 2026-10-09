/** PostgreSQL proof for ahead registration, namespace races, and settlement CAS. */
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    const AHEAD = "ahead:00000000-0000-4000-8000-000000000b05";
    const database = createDb(DATABASE_URL, { max: 4 });
    const second = createDb(DATABASE_URL, { max: 2 });

    beforeAll(async () => {
      await deleteDrizzleRows(database, [users]);
    });
    beforeEach(async () => {
      await deleteDrizzleRows(database, [users]);
      await database.insert(users).values(conformanceUserValues(USER, "ahead-registry"));
      await database.insert(projects).values({
        id: PROJECT,
        userId: USER,
        name: "Ahead Project",
        slug: "ahead-project",
      });
      await database.insert(contextSources).values({
        id: SOURCE,
        projectId: PROJECT,
        name: "Manuscript",
        slug: "manuscript",
      });
    });
    afterAll(async () => {
      await deleteDrizzleRows(database, [users]);
      await second.close();
      await database.close();
    });

    async function arrive(db: Database): Promise<number> {
      return runInDrizzleTransaction(db, async () => {
        await lockNamespaceKeys(db, [
          { projectId: PROJECT, userId: USER, scheme: "manuscript", workId: null },
        ]);
        await db.insert(documents).values({
          id: DOCUMENT,
          contextSourceId: SOURCE,
          name: "chapter",
          extension: "md",
        });
        return createDrizzleLinkAheadRegistry(db).settleArrivals([DOCUMENT]);
      });
    }

    it("registration racing arrival with two real connections settles exactly once in both orders", async () => {
      const registration = {
        aheadId: AHEAD,
        holderProjectId: PROJECT,
        address: "manuscript://chapter.md",
      };
      const first = createDrizzleLinkAheadRegistry(database);
      const secondRegistry = createDrizzleLinkAheadRegistry(second);

      // Arrival first: hold the namespace while registration waits, then settle in arrival tx.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const arrival = runInDrizzleTransaction(second, async () => {
        await lockNamespaceKeys(second, [
          { projectId: PROJECT, userId: USER, scheme: "manuscript", workId: null },
        ]);
        await second
          .insert(documents)
          .values({ id: DOCUMENT, contextSourceId: SOURCE, name: "chapter", extension: "md" });
        ready();
        await held;
        return createDrizzleLinkAheadRegistry(second).settleArrivals([DOCUMENT]);
      });
      await started;
      const waitingRegistration = first.register([registration]);
      release();
      await Promise.all([arrival, waitingRegistration]);
      await expect(secondRegistry.settleArrivals([DOCUMENT])).resolves.toBe(0);
      await expect(
        database.select({ settled: linkAheadRefs.settledDocumentId }).from(linkAheadRefs),
      ).resolves.toEqual([{ settled: DOCUMENT }]);

      // Registration first, then arrival: the registration sees no occupant and arrival CAS settles it.
      await deleteDrizzleRows(database, [users]);
      await database.insert(users).values(conformanceUserValues(USER, "ahead-registry-2"));
      await database
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Ahead Project", slug: "ahead-project" });
      await database
        .insert(contextSources)
        .values({ id: SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript" });
      await first.register([
        { ...registration, aheadId: "ahead:00000000-0000-4000-8000-000000000b06" },
      ]);
      await expect(arrive(second)).resolves.toBe(1);
    });

    it("settles occupied rows, keeps an orphan after caller rollback, rejects mismatched addresses, and guards transactions", async () => {
      await database
        .insert(documents)
        .values({ id: DOCUMENT, contextSourceId: SOURCE, name: "chapter", extension: "md" });
      const registry = createDrizzleLinkAheadRegistry(database);
      await registry.register([
        { aheadId: AHEAD, holderProjectId: PROJECT, address: "manuscript://chapter.md" },
      ]);
      await expect(
        database
          .select()
          .from(linkAheadRefs)
          .where(eq(linkAheadRefs.aheadId, AHEAD.slice(6))),
      ).resolves.toHaveLength(1);
      await expect(
        registry.register([
          { aheadId: AHEAD, holderProjectId: PROJECT, address: "manuscript://other.md" },
        ]),
      ).rejects.toThrow(/another address/);
      await expect(
        runInDrizzleTransaction(database, () =>
          registry.register([
            {
              aheadId: "ahead:00000000-0000-4000-8000-000000000b07",
              holderProjectId: PROJECT,
              address: "manuscript://orphan.md",
            },
          ]),
        ),
      ).rejects.toBeInstanceOf(RegistrationInsideTransactionError);
      await expect(
        database
          .select()
          .from(linkAheadRefs)
          .where(and(eq(linkAheadRefs.projectId, PROJECT), eq(linkAheadRefs.path, "orphan.md"))),
      ).resolves.toHaveLength(0);
    });
  });
}
