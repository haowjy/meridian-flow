/**
 * Regression (pr2-before §1): an archived Work's scratch stayed writable to
 * `undo` and `redo`. The file policy refuses it at preflight, an edit granted
 * before the archive is refused when the save confirms it, and an agent write
 * that reaches the journal with no grant at all is refused there.
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
import {
  type AgentChain,
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
  isFileAccessDenied,
  type Principal,
  UngrantedAgentWriteError,
} from "./index.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("file access on an archived Work (postgres)", () => {});
} else {
  describe("file access on an archived Work (postgres)", () => {
    const u = "00000000-0000-4000-8000-000000000b00";
    const p = "00000000-0000-4000-8000-000000000b01";
    const w = "00000000-0000-4000-8000-000000000b02";
    const source = "00000000-0000-4000-8000-000000000b03";
    const probe = "00000000-0000-4000-8000-000000000b04";
    const turn = "00000000-0000-4000-8000-000000000b05";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    const chain: AgentChain = [{ threadId: "thread", permission: "edit", threadWorkId: w }];
    const person: Principal = { accountId: u };
    const agent: Principal = { accountId: u, agent: { chain, draftWork: null } };
    const target = { kind: "document", documentId: probe } as const;

    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "archived-scratch"));
      await db.insert(projects).values({ id: p, userId: u, name: "Probe", slug: "probe" });
      await db.insert(works).values({
        id: w,
        projectId: p,
        createdByUserId: u,
        name: "Archived scratch probe",
        slug: "archived-scratch-probe",
      });
      await db
        .insert(contextSources)
        .values({ id: source, workId: w, scope: "work", name: "Scratch", slug: "scratch" });
      await db.insert(documents).values({ id: probe, contextSourceId: source, name: "probe" });
    });

    const access = () =>
      createFileAccess({
        facts: createDrizzleFileFacts(database.current),
        grants: createOwnerFileGrants(),
        readAgentChain: async () => chain,
      });
    const archive = () =>
      database.current.update(works).set({ archivedAt: new Date() }).where(eq(works.id, w));

    it("refuses edits to an archived Work's scratch and still reads it", async () => {
      await archive();
      for (const principal of [person, agent]) {
        const edit = await access().authorize(principal, target, "edit");
        expect(edit).toMatchObject({
          denied: true,
          reason: "work_archived",
          archivedWork: { id: w, slug: "archived-scratch-probe" },
        });
        expect(isFileAccessDenied(await access().authorize(principal, target, "read"))).toBe(false);
      }
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

    it("refuses at save an edit granted before the archive", async () => {
      const grant = await access().authorize(agent, target, "edit");
      if (isFileAccessDenied(grant)) throw new Error("expected an edit grant while active");
      await archive();
      const { confirmed, refused } = await access().confirmEdit([grant]);
      expect(confirmed).toEqual([]);
      expect(refused).toMatchObject([{ reason: "work_archived", target }]);
    });
  });
}
