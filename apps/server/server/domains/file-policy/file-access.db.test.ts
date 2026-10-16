/** Consolidated test contracts; each block retains its original fixture scope. */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsUpdates,
  folders,
  projects,
  threads,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe as __mergedSuite, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { UngrantedAgentWriteError } from "../../shared/edit-confirmation.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createDrizzleJournal } from "../collab/adapters/drizzle-journal.js";
import { createDrizzleFileFacts } from "./adapters/drizzle-file-facts.js";
import {
  type AgentChain,
  createDrizzleFileFacts as createDrizzleFileFacts__merged0,
  createFileAccess,
  createOwnerFileGrants,
  type FileGrant,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "./index.js";

__mergedSuite("file-access.db.test.ts", () => {
  // Merged from apps/server/server/domains/file-policy/file-access.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("agent journal writes need a covering grant (postgres)", () => {});
  } else {
    __mergedSuite("agent journal writes need a covering grant (postgres)", () => {
      const u = "00000000-0000-4000-8000-000000000b00";
      const p = "00000000-0000-4000-8000-000000000b01";
      const w = "00000000-0000-4000-8000-000000000b02";
      const source = "00000000-0000-4000-8000-000000000b03";
      const probe = "00000000-0000-4000-8000-000000000b04";
      const turn = "00000000-0000-4000-8000-000000000b05";
      const database = useRollbackTestDatabase(DATABASE_URL, {
        prepareSuite: (db) => deleteDrizzleRows(db, [users]),
      });
      const chain: AgentChain = [
        {
          threadId: "thread",
          permission: "edit",
          threadWorkId: w,
          scratchOwner: { scope: "work", workId: w },
        },
      ];
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
          facts: createDrizzleFileFacts__merged0(database.current),
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
});

__mergedSuite("drizzle-file-facts.db.test.ts", () => {
  // Merged from apps/server/server/domains/file-policy/adapters/drizzle-file-facts.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("drizzle file facts (postgres)", () => {});
  } else {
    __mergedSuite("drizzle file facts (postgres)", () => {
      const u = "00000000-0000-4000-8000-000000000a00";
      const p = "00000000-0000-4000-8000-000000000a01";
      const noWork = "00000000-0000-4000-8000-000000000a02";
      const a = "00000000-0000-4000-8000-000000000a03";
      const manuscript = "00000000-0000-4000-8000-000000000a10";
      const scratch = "00000000-0000-4000-8000-000000000a11";
      const noWorkScratch = "00000000-0000-4000-8000-000000000a12";
      const chapters = "00000000-0000-4000-8000-000000000a20";
      const arc = "00000000-0000-4000-8000-000000000a21";
      const chapter = "00000000-0000-4000-8000-000000000a30";
      const note = "00000000-0000-4000-8000-000000000a31";
      const noWorkNote = "00000000-0000-4000-8000-000000000a32";
      const database = useRollbackTestDatabase(DATABASE_URL, {
        prepareSuite: (db) => deleteDrizzleRows(db, [users]),
      });
      beforeEach(async () => {
        const db = database.current;
        await db.insert(users).values(conformanceUserValues(u, "file-facts"));
        await db.insert(projects).values({ id: p, userId: u, name: "Serial", slug: "serial" });
        await db.insert(works).values([
          { id: noWork, projectId: p, createdByUserId: u, name: "No Work", isNoWork: true },
          { id: a, projectId: p, createdByUserId: u, name: "Arc A", slug: "arc-a" },
        ]);
        await db.insert(contextSources).values([
          { id: manuscript, projectId: p, name: "Manuscript", slug: "manuscript" },
          { id: scratch, workId: a, scope: "work", name: "Scratch", slug: "scratch" },
          { id: noWorkScratch, workId: noWork, scope: "work", name: "Scratch", slug: "scratch" },
        ]);
        await db.insert(folders).values([
          { id: chapters, contextSourceId: manuscript, name: "chapters" },
          { id: arc, contextSourceId: manuscript, parentId: chapters, name: "arc-1" },
        ]);
        await db.insert(documents).values([
          { id: chapter, contextSourceId: manuscript, folderId: arc, name: "ch1" },
          { id: note, contextSourceId: scratch, name: "notes" },
          { id: noWorkNote, contextSourceId: noWorkScratch, name: "notes" },
        ]);
      });
      it("loads documents, drafts and containers with their ancestors", async () => {
        const facts = createDrizzleFileFacts(database.current);
        const ch1 = await facts.load({ target: { kind: "document", documentId: chapter } });
        expect(ch1).toMatchObject({
          projectId: p,
          ownerAccountId: u,
          projectDeleted: false,
          ownerWork: null,
          deleted: false,
          scheme: "manuscript",
          self: { kind: "document", id: chapter },
          ancestors: [
            { kind: "folder", id: arc },
            { kind: "folder", id: chapters },
            { kind: "source", id: manuscript },
            { kind: "project", id: p },
          ],
        });
        const scratchNote = await facts.load({ target: { kind: "document", documentId: note } });
        expect(scratchNote?.ownerWork).toEqual({
          id: a,
          slug: "arc-a",
          isNoWork: false,
          archived: false,
          deleted: false,
        });
        expect(scratchNote?.ancestors).toEqual([
          { kind: "source", id: scratch },
          { kind: "work", id: a },
          { kind: "project", id: p },
        ]);
        // No Work owns its scratch like any Work (D55).
        const noWorkScratchNote = await facts.load({
          target: { kind: "document", documentId: noWorkNote },
        });
        expect(noWorkScratchNote?.ownerWork).toMatchObject({ id: noWork, isNoWork: true });
        const drafted = await facts.load({
          target: { kind: "document", documentId: chapter },
          draftWorkId: a,
        });
        expect(drafted?.draftWork?.id).toBe(a);
        const container = await facts.load({
          target: { kind: "container", scheme: "scratch", owner: { scope: "work", workId: a } },
        });
        expect(container).toMatchObject({ self: null, ownerWork: { id: a } });
        expect(container?.ancestors).toEqual(scratchNote?.ancestors);
        expect(
          await facts.load({ target: { kind: "document", documentId: crypto.randomUUID() } }),
        ).toBeNull();
      });
      it("reads lifecycle through folders and Works", async () => {
        const db = database.current;
        await db.update(folders).set({ deletedAt: new Date() }).where(eq(folders.id, chapters));
        await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, a));
        const facts = createDrizzleFileFacts(db);
        const ch1 = await facts.load({ target: { kind: "document", documentId: chapter } });
        const scratchNote = await facts.load({ target: { kind: "document", documentId: note } });
        expect(ch1?.deleted).toBe(true);
        expect(scratchNote?.ownerWork?.archived).toBe(true);
      });
    });
  }
});
