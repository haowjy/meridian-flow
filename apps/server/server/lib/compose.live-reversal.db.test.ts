/**
 * Production-composed model undo and redo of writes that went live (D19, D41,
 * D42): direct mode, No Work, scratch inside a draft-mode Work, and copies.
 * Their history is the live journal, since no thread-peer branch exists.
 */

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed live reversal (postgres)", () => {});
} else {
  describe("production-composed live reversal (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { unloadHocuspocus, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000c01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000c02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000c03";
    const WORK_ID = "00000000-0000-4000-8000-000000000c04";
    const NO_WORK_ID = "00000000-0000-4000-8000-000000000c05";
    // The drafted reference run gets its own thread, so both runs share one test transaction.
    const LIVE = {
      threadId: "00000000-0000-4000-8000-000000000c06",
      turnId: "00000000-0000-4000-8000-000000000c07",
    };
    const DRAFTED = {
      threadId: "00000000-0000-4000-8000-000000000c09",
      turnId: "00000000-0000-4000-8000-000000000c0a",
    };
    const DRAFT_WORK_ID = "00000000-0000-4000-8000-000000000c0b";
    type Thread = typeof LIVE;
    const DOC_ID = "00000000-0000-4000-8000-000000000c08";
    const CHAPTER = "manuscript://chapter.md";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "live-reversal"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Live reversal",
        slug: "live-reversal",
      });
      await db.insert(schema.works).values([
        {
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Rewrite",
          slug: "rewrite",
          aiWriteMode: "direct",
        },
        {
          id: DRAFT_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Drafts",
          slug: "drafts",
          aiWriteMode: "draft",
        },
        {
          id: NO_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "No Work",
          slug: null,
          isNoWork: true,
          aiWriteMode: "direct",
        },
      ]);
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.documents).values({
        id: DOC_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      for (const thread of [LIVE, DRAFTED]) {
        await db.insert(schema.threads).values({
          rootThreadId: thread.threadId,
          id: thread.threadId,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Live reversal",
          kind: "primary",
          status: "idle",
        });
        await db.insert(schema.turns).values({
          id: thread.turnId,
          threadId: thread.threadId,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
      }
      await db.insert(schema.threadWorks).values({
        threadId: DRAFTED.threadId,
        workId: DRAFT_WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    async function bindLiveThread(workId: string, aiWriteMode: "direct" | "draft") {
      await db.update(schema.works).set({ aiWriteMode }).where(eq(schema.works.id, workId));
      await db.insert(schema.threadWorks).values({
        threadId: LIVE.threadId,
        workId,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    }

    /** The chapter's thread-peer branches for the live thread: live writes make none. */
    function liveThreadBranches() {
      return db
        .select({ id: schema.documentBranches.id })
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, DOC_ID),
            eq(schema.documentBranches.threadId, LIVE.threadId),
          ),
        );
    }

    /** One model reply per step, each saved before the next starts. */
    async function startScript(thread: Thread = LIVE) {
      const runtime = await runtimes.compose();
      await runtime.ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Writer opening.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: thread.threadId,
      });
      await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
        projectId: PROJECT_ID,
      });
      return runtimes.script(runtime, thread);
    }

    /** Two writes, then undo, redo and a range undo of both: every receipt in order. */
    async function undoRedoScript(path: string, thread: Thread = LIVE) {
      const script = await startScript(thread);
      const version = thread === DRAFTED ? undefined : ("live" as const);
      const outputs: string[] = [];
      try {
        // Separate replies: one reply's edits to one block share a write handle.
        await script.reply(async (call) => {
          await call("read", { path });
          outputs.push(
            await call("write", { command: "insert", path, find: "opening.", content: " One." }),
          );
        });
        await script.reply(async (call) => {
          outputs.push(
            await call("write", { command: "insert", path, find: "One.", content: " Two." }),
          );
        });
        const [first, second] = outputs.map((output) => /write: (w\d+)/.exec(output)?.[1]);
        expect(await script.text(path, version)).toContain("Writer opening. One. Two.");
        const availability = await script.runtime.ports.documentSync
          .agentEdit()
          .getAvailability(DOC_ID, thread.threadId);
        expect(availability).toMatchObject({ undo: true, redo: false });

        await script.reply(async (call) => {
          outputs.push(await call("write", { command: "undo", path, last: 1 }));
        });
        expect(await script.text(path, version)).toMatch(/\|Writer opening\. One\.$/);
        await script.reply(async (call) => {
          outputs.push(await call("write", { command: "redo", path, last: 1 }));
        });
        expect(await script.text(path, version)).toContain("Writer opening. One. Two.");
        await script.reply(async (call) => {
          outputs.push(await call("write", { command: "undo", path, since: first, to: second }));
        });
        expect(await script.text(path, version)).toMatch(/\|Writer opening\.$/);
        return outputs;
      } finally {
        await unloadHocuspocus(script.runtime.hocuspocus);
      }
    }

    function withoutDraftNote(outputs: string[]): string[] {
      return outputs.map((output) => output.replaceAll(" (drafted in @drafts)", ""));
    }

    it("undoes and redoes direct-mode writes like drafted ones", async () => {
      const drafted = await undoRedoScript(CHAPTER, DRAFTED);
      await bindLiveThread(WORK_ID, "direct");

      const live = await undoRedoScript(CHAPTER);

      expect(live).toEqual(withoutDraftNote(drafted));
      expect(await liveThreadBranches()).toEqual([]);
    });

    it("undoes and redoes No Work writes", async () => {
      await bindLiveThread(NO_WORK_ID, "direct");

      const live = await undoRedoScript(CHAPTER);

      expect(live).toHaveLength(5);
      expect(await liveThreadBranches()).toEqual([]);
    });

    it("undoes and redoes scratch writes inside a draft-mode Work", async () => {
      await bindLiveThread(WORK_ID, "draft");
      const script = await startScript();
      try {
        const outputs: string[] = [];
        await script.reply(async (call) => {
          await call("write", { command: "create", path: "scratch://notes.md", content: "Notes." });
          await call("read", { path: CHAPTER });
          outputs.push(
            await call("write", {
              command: "insert",
              path: CHAPTER,
              find: "opening.",
              content: " Drafted.",
            }),
          );
        });
        await script.reply(async (call) => {
          await call("read", { path: "scratch://notes.md" });
          outputs.push(
            await call("write", {
              command: "insert",
              path: "scratch://notes.md",
              find: "Notes.",
              content: " More.",
            }),
          );
        });
        expect(await script.text("scratch://notes.md")).toContain("Notes. More.");
        await script.reply(async (call) => {
          outputs.push(
            await call("write", { command: "undo", path: "scratch://notes.md", last: 1 }),
          );
        });
        expect(await script.text("scratch://notes.md")).not.toContain("More.");
        await script.reply(async (call) => {
          outputs.push(
            await call("write", { command: "redo", path: "scratch://notes.md", last: 1 }),
          );
        });
        expect(await script.text("scratch://notes.md")).toContain("Notes. More.");
        // The drafted chapter keeps its own history beside the live scratch one.
        expect(await script.text(CHAPTER)).toContain("Writer opening. Drafted.");
        expect(await script.text(CHAPTER, "live")).not.toContain("Drafted.");
        expect(outputs.slice(1).join("\n")).not.toContain("drafted in");
      } finally {
        await unloadHocuspocus(script.runtime.hocuspocus);
      }
    });

    it("undoes a direct-mode copy like a drafted one", async () => {
      const copyScript = async (thread: Thread) => {
        const script = await startScript(thread);
        const outputs: string[] = [];
        try {
          await script.reply(async (call) => {
            outputs.push(
              await call("write", {
                command: "copy",
                from: { path: CHAPTER },
                path: `manuscript://copy-${thread === LIVE ? "live" : "drafted"}.md`,
              }),
            );
          });
          await script.reply(async (call) => {
            outputs.push(
              await call("write", {
                command: "undo",
                path: `manuscript://copy-${thread === LIVE ? "live" : "drafted"}.md`,
              }),
            );
          });
          expect(
            await script.text(`manuscript://copy-${thread === LIVE ? "live" : "drafted"}.md`),
          ).not.toContain("Writer opening.");
          return outputs;
        } finally {
          await unloadHocuspocus(script.runtime.hocuspocus);
        }
      };
      const drafted = await copyScript(DRAFTED);
      await bindLiveThread(WORK_ID, "direct");

      const live = await copyScript(LIVE);

      expect(live.map((output) => output.replaceAll("copy-live", "copy-drafted"))).toEqual(
        withoutDraftNote(drafted),
      );
    });
  });
}
