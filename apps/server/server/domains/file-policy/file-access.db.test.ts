/**
 * Regression (pr2-before §1): an agent write that reaches the journal with no
 * confirmed grant is refused there. Archived-Work refusals live in
 * `policy.test.ts` and `response-save-destinations.db.test.ts`.
 */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsUpdates,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createDrizzleJournal } from "../collab/adapters/drizzle-journal.js";
import { UngrantedAgentWriteError } from "./index.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("ungranted agent journal writes (postgres)", () => {});
} else {
  describe("ungranted agent journal writes (postgres)", () => {
    const u = "00000000-0000-4000-8000-000000000b00";
    const p = "00000000-0000-4000-8000-000000000b01";
    const w = "00000000-0000-4000-8000-000000000b02";
    const source = "00000000-0000-4000-8000-000000000b03";
    const probe = "00000000-0000-4000-8000-000000000b04";
    const turn = "00000000-0000-4000-8000-000000000b05";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "ungranted-write"));
      await db.insert(projects).values({ id: p, userId: u, name: "Probe", slug: "probe" });
      await db.insert(works).values({
        id: w,
        projectId: p,
        createdByUserId: u,
        name: "Scratch probe",
        slug: "scratch-probe",
      });
      await db
        .insert(contextSources)
        .values({ id: source, workId: w, scope: "work", name: "Scratch", slug: "scratch" });
      await db.insert(documents).values({ id: probe, contextSourceId: source, name: "probe" });
    });

    it("refuses an agent's journal write that carries no grant", async () => {
      const journal = createDrizzleJournal(database.current);
      const update = Y.encodeStateAsUpdate(new Y.Doc());
      const meta = { origin: `agent:${turn}`, actorTurnId: turn, seq: 0 };
      await expect(journal.append(probe, update, meta)).rejects.toBeInstanceOf(
        UngrantedAgentWriteError,
      );
      await expect(journal.appendBatch([{ docId: probe, update, meta }])).rejects.toBeInstanceOf(
        UngrantedAgentWriteError,
      );
      const rows = await database.current
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, probe));
      expect(rows).toEqual([]);
    });
  });
}
