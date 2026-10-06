/**
 * An agent write that reaches the journal is refused there unless a bound
 * grant covers the document it writes.
 */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsUpdates,
  projects,
  threads,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { UngrantedAgentWriteError } from "../../shared/edit-confirmation.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createDrizzleJournal } from "../collab/adapters/drizzle-journal.js";
import {
  type AgentChain,
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
  type FileGrant,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "./index.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("agent journal writes need a covering grant (postgres)", () => {});
} else {
  describe("agent journal writes need a covering grant (postgres)", () => {
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
    const agent: Principal = { accountId: u, agent: { chain, draftWork: null } };

    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "agent-journal-grant"));
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

    it("refuses an agent's journal write its bound grants don't cover", async () => {
      const kbSource = "00000000-0000-4000-8000-000000000b06";
      await database.current
        .insert(contextSources)
        .values({ id: kbSource, projectId: p, scope: "project", name: "Knowledge", slug: "kb" });
      const thread = "00000000-0000-4000-8000-000000000b07";
      await database.current.insert(threads).values({
        rootThreadId: thread,
        id: thread,
        projectId: p,
        createdByUserId: u,
        title: "Thread",
        kind: "primary",
        status: "idle",
      });
      await database.current.insert(turns).values({
        id: turn,
        threadId: thread,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const containerGrant = async (target: FileTarget) => {
        const grant = await access().authorize(agent, target, "edit");
        if (isFileAccessDenied(grant)) throw new Error(`Denied: ${grant.reason}`);
        return grant;
      };
      const journal = createDrizzleJournal(database.current);
      const update = Y.encodeStateAsUpdate(new Y.Doc());
      const meta = { origin: `agent:${turn}`, actorTurnId: turn, seq: 0 };
      const appendUnder = (grant: FileGrant<"edit">) =>
        runWithEditGrants(access(), [grant], () => journal.append(probe, update, meta));

      // A create's grant in the knowledge base doesn't reach a scratch file.
      const kb = await containerGrant({
        kind: "container",
        scheme: "kb",
        owner: { scope: "project", projectId: p },
      });
      await expect(appendUnder(kb)).rejects.toBeInstanceOf(UngrantedAgentWriteError);
      const scratch = await containerGrant({
        kind: "container",
        scheme: "scratch",
        owner: { scope: "work", workId: w },
      });
      await expect(appendUnder(scratch)).resolves.toMatchObject({ ok: true });
    });
  });
}
