/**
 * Production-composed model tools in a Work: scratch stays live while drafted writes name the draft (D9, D19), read, search and ls follow the version the writes change (D41), copies of text and binary files (D24), and a chat's write-mode switch against real repositories (D62).
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - scheme-specific write destinations, queued mode switches, and no-op write suppression
 */

import { splitHashline } from "@meridian/agent-edit";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";
import { processDetachedWork } from "../domains/runtime/detached-work.js";
import type { ToolCall } from "../test-support/composed-runtime.js";
import { releaseLeaseUnderLock } from "../test-support/release-lease.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed model tools in a Work (postgres)", () => {});
} else {
  describe("production-composed model tools in a Work (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDb } = await import("@meridian/database");
    const { deleteDrizzleRows } = await import("../test-support/drizzle-reset.js");
    const { bindEditAgent, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );
    const { branchTreeScenario } = await import("../test-support/branch-tree-scenario.js");

    const USER_ID = "00000000-0000-4000-8000-000000000e01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000e02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000e03";
    const WORK_ID = "00000000-0000-4000-8000-000000000e04";
    const THREAD = {
      threadId: "00000000-0000-4000-8000-000000000e05",
      turnId: "00000000-0000-4000-8000-000000000e06",
    };
    const DOC_ID = "00000000-0000-4000-8000-000000000e07";
    const CHAPTER = "manuscript://chapter";
    // Copies create documents, which repair the project catalog after commit:
    // that background work needs real commits, so this suite doesn't roll back.
    const db = createDb(DATABASE_URL, { max: 6 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "draft-mode-tools"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Draft-mode tools",
        slug: "draft-mode-tools",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Rewrite",
        handle: "w1",
      });
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
        extension: "",
        fileType: "markdown",
      });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD.threadId,
        id: THREAD.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft-mode tools",
        kind: "primary",
        status: "idle",
        aiWriteMode: "draft",
      });
      await db.insert(schema.turns).values({
        id: THREAD.turnId,
        threadId: THREAD.threadId,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD.threadId,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    /** A composed runtime with the writer's chapter already live. */
    async function startWithChapter(markdown: string) {
      const runtime = await runtimes.compose();
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: DOC_ID,
        markdown,
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD.threadId,
      });
      return runtimes.script(runtime, THREAD);
    }

    const text = (result: { output: unknown }) =>
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);

    it("drafts kb and manuscript, keeps scratch live, and reads the version writes change", async () => {
      const script = await startWithChapter("Writer live content.\n\nWriter aside.");
      const first = await script.begin();
      let call = first.call;

      const liveBefore = await call("read", { path: CHAPTER, version: "live" });
      const asideLine = text(liveBefore)
        .split("\n")
        .find((line: string) => line.endsWith("|Writer aside."));
      const liveHash = splitHashline(asideLine ?? "")?.hash;
      expect(liveHash).toBeTruthy();
      await call("read", { path: CHAPTER });
      await call("write", { command: "remove", path: CHAPTER, in: liveHash });
      const drafted = await call("write", {
        command: "replace",
        path: CHAPTER,
        find: "Writer live content.",
        content: "Model draft content.",
      });
      expect(drafted.result).toMatchObject({ destination: "draft" });
      const lore = await call("write", {
        command: "create",
        path: "kb://lore",
        content: "Drafted lore needle.",
      });
      expect(lore.result).toMatchObject({ destination: "draft" });
      // Scratch is live in every Work (D9).
      const notes = await call("write", {
        command: "create",
        path: "scratch://notes",
        content: "Scratch needle notes.",
      });
      expect(notes.result).toMatchObject({ destination: "live" });
      await first.save();

      call = (await script.begin()).call;
      const draftRead = await call("read", { path: CHAPTER });
      expect(draftRead.result).toMatchObject({ read: { version: "draft" } });
      expect(draftRead.output).toContain("Model draft content.");
      const liveRead = await call("read", { path: CHAPTER, version: "live" });
      expect(liveRead.output).toContain("Writer live content.");
      expect(liveRead.output).not.toContain("Model draft content.");

      // The last read was the draft, so the stale live hash reaches the resolver.
      await call("read", { path: CHAPTER });
      const stale = await call("write", {
        command: "replace",
        path: CHAPTER,
        in: liveHash,
        content: "Never lands.",
      });
      expect(stale.isError).toBe(true);

      const loreHits = await call("search", { pattern: "lore needle" });
      expect(text(loreHits)).toContain("kb://lore");
      const listedLive = await call("ls", { path: "kb://", version: "live" });
      expect(text(listedLive)).toMatch(/^kb:\/\//);
      expect(text(listedLive)).not.toContain("lore");
    });

    it("the turn card hides a drafted creation and redo reveals its retained text", async () => {
      const script = await startWithChapter("Writer live content.");
      const reply = await script.begin();
      const created = await reply.call("write", {
        command: "create",
        path: "manuscript://new-chapter",
        content: "The new chapter.",
      });
      expect(created.isError, text(created)).toBeFalsy();
      const documentId = (created.metadata as { documentId?: unknown } | undefined)?.documentId;
      if (typeof documentId !== "string") throw new Error("Create returned no document identity");
      await reply.save();

      const receipt = await script.runtime.ports.documentSync.listEditedDocumentsForTurn(
        THREAD.threadId as never,
        THREAD.turnId as never,
      );
      expect(receipt.map((document) => document.documentId)).toContain(documentId);

      const reverse = (direction: "undo" | "redo") =>
        script.runtime.ports.documentSync.reverseThreadContext({
          threadId: THREAD.threadId as never,
          userId: USER_ID as never,
          direction,
          turnId: THREAD.turnId as never,
        });
      expect(await reverse("undo")).toMatchObject({ status: "reversed" });
      const [removed] = await db
        .select({ deletedAt: schema.documents.deletedAt })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentId));
      expect(removed?.deletedAt).toBeNull();
      expect(
        (await db.select().from(schema.branchTreeChanges)).filter(
          (row) => row.nodeId === documentId,
        ),
      ).toEqual([expect.objectContaining({ created: true, deleted: true })]);
      expect(
        (await db.select().from(schema.documentDrafts)).filter(
          (row) => row.documentId === documentId && row.status === "active",
        ),
      ).not.toEqual([]);

      const redone = await reverse("redo");
      expect(redone).toMatchObject({ status: "reversed" });
      expect(
        (await db.select().from(schema.branchTreeChanges)).filter(
          (row) => row.nodeId === documentId,
        ),
      ).toEqual([expect.objectContaining({ created: true, deleted: false })]);
      expect(await script.text("new-chapter")).toContain("The new chapter.");
    });

    // D62: auto-apply writes live, but an explicit `draft` still reads what the Work kept.
    it("reads a kept draft when asked for draft in auto-apply, and live otherwise", async () => {
      const script = await startWithChapter("Writer live content.");
      const first = await script.begin();
      await first.call("read", { path: CHAPTER });
      await first.call("write", {
        command: "replace",
        path: CHAPTER,
        find: "Writer live content.",
        content: "Kept draft content.",
      });
      await first.save();
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.threads.id, THREAD.threadId));

      const { call } = await script.begin();
      const kept = await call("read", { path: CHAPTER, version: "draft" });
      expect(kept.result).toMatchObject({ read: { version: "draft" } });
      expect(kept.output).toContain("Kept draft content.");
      const destination = await call("read", { path: CHAPTER });
      expect(destination.result).toMatchObject({ read: { version: "live" } });
      expect(destination.output).toContain("Writer live content.");
      const notes = await call("write", {
        command: "create",
        path: "scratch://notes",
        content: "Notes.",
      });
      expect(notes.isError).toBeFalsy();
      const noDraft = await call("read", { path: "scratch://notes", version: "draft" });
      expect(noDraft.result).toMatchObject({ read: { version: "live" } });
    });

    describe("write-mode switch (D62)", () => {
      const SIBLING = {
        threadId: "00000000-0000-4000-8000-000000000e15",
        turnId: "00000000-0000-4000-8000-000000000e16",
      };
      const switchTo = (
        runtime: Awaited<ReturnType<typeof runtimes.compose>>,
        mode: "direct" | "draft",
      ) =>
        runtime.app.delivery.enqueueControl({
          threadId: THREAD.threadId,
          provenance: { kind: "writer", actorId: USER_ID },
          id: crypto.randomUUID(),
          control: { kind: "write_mode", mode },
        });
      const switchTurns = async () =>
        (
          await db.select().from(schema.turns).where(eq(schema.turns.threadId, THREAD.threadId))
        ).filter(
          (turn) => (turn.metadata as { kind?: string } | null)?.kind === "write_mode_switch",
        );
      const modeOf = async (threadId: string) =>
        (
          await db
            .select({ mode: schema.threads.aiWriteMode })
            .from(schema.threads)
            .where(eq(schema.threads.id, threadId))
        )[0]?.mode;
      const create = (call: ToolCall, name: string) =>
        call("write", { command: "create", path: `manuscript://${name}.md`, content: name });

      beforeEach(async () => {
        // A switch turn chains after the chat's active leaf.
        await db
          .update(schema.threads)
          .set({ activeLeafTurnId: THREAD.turnId })
          .where(eq(schema.threads.id, THREAD.threadId));
      });

      it("keeps a reply's mode past a mid-reply switch, which stays pending after the reply", async () => {
        const script = await startWithChapter("Writer live content.");
        const { runtime } = script;
        await db
          .update(schema.works)
          .set({ defaultAiWriteMode: "draft" })
          .where(eq(schema.works.id, WORK_ID));
        const lease = await runtime.ports.runClaim.startExecution(
          THREAD.threadId as never,
          crypto.randomUUID() as never,
          async () => {},
        );
        if (!lease) throw new Error("Expected the reply's run claim");
        const reply = await script.begin();
        expect((await create(reply.call, "before")).result).toMatchObject({
          destination: "draft",
        });

        const queued = await reply.call("work", { command: "write_mode", mode: "direct" });
        expect(queued.output).toBe("AI write mode will change to direct from the next reply.");
        expect(
          await db
            .select({
              body: schema.threadInboxMessages.body,
              provenance: schema.threadInboxMessages.provenance,
            })
            .from(schema.threadInboxMessages)
            .where(eq(schema.threadInboxMessages.threadId, THREAD.threadId)),
        ).toMatchObject([
          {
            body: { kind: "write_mode", mode: "direct" },
            provenance: { kind: "agent", threadId: THREAD.threadId },
          },
        ]);
        expect(
          (
            await db
              .select({ mode: schema.works.defaultAiWriteMode })
              .from(schema.works)
              .where(eq(schema.works.id, WORK_ID))
          )[0]?.mode,
        ).toBe("draft");
        const writerControlId = crypto.randomUUID();
        await runtime.app.delivery.enqueueControl({
          threadId: THREAD.threadId,
          id: writerControlId,
          provenance: { kind: "writer", actorId: USER_ID },
          control: { kind: "write_mode", mode: "direct" },
        });
        expect(
          (
            await db
              .select({ mode: schema.works.defaultAiWriteMode })
              .from(schema.works)
              .where(eq(schema.works.id, WORK_ID))
          )[0]?.mode,
        ).toBe("direct");
        expect(
          await runtime.app.delivery.enqueueControl({
            threadId: THREAD.threadId,
            id: writerControlId,
            provenance: { kind: "writer", actorId: USER_ID },
            control: { kind: "write_mode", mode: "direct" },
          }),
        ).toMatchObject({ created: false });
        expect((await create(reply.call, "after")).result).toMatchObject({
          destination: "draft",
        });
        await reply.save();
        expect(await switchTurns()).toEqual([]);

        // The release wake has nothing to run, so the switch stays pending and the chat keeps its mode.
        await releaseLeaseUnderLock(runtime.ports.db, runtime.ports.runClaim, lease);
        await runtime.app.runStarter.start(THREAD.threadId as never);
        await processDetachedWork.drain();
        expect(await switchTurns()).toEqual([]);
        expect(await modeOf(THREAD.threadId)).toBe("draft");

        const next = await script.begin();
        expect((await create(next.call, "next")).result).toMatchObject({ destination: "draft" });
      });

      it("moves the Work default when the writer switches, leaving the chat and a sibling chat in their mode", async () => {
        await db
          .update(schema.works)
          .set({ defaultAiWriteMode: "draft" })
          .where(eq(schema.works.id, WORK_ID));
        await db.insert(schema.threads).values({
          rootThreadId: SIBLING.threadId,
          id: SIBLING.threadId,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Sibling",
          kind: "primary",
          status: "idle",
          aiWriteMode: "draft",
        });
        await db.insert(schema.turns).values({
          id: SIBLING.turnId,
          threadId: SIBLING.threadId,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await db.insert(schema.threadWorks).values({
          threadId: SIBLING.threadId,
          workId: WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
        const script = await startWithChapter("Writer live content.");
        const { runtime } = script;
        await bindEditAgent(runtime, THREAD.threadId);
        const [before] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));

        const switched = await switchTo(runtime, "direct");
        expect(switched.response).toMatchObject({
          runState: { items: [{ control: { kind: "write_mode", mode: "direct" } }], mode: "draft" },
          turnId: null,
        });
        expect(await switchTurns()).toEqual([]);
        expect(await modeOf(THREAD.threadId)).toBe("draft");
        // The Work's default follows the writer's choice at once, so a new chat starts in it.
        const [after] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));
        expect(after?.defaultAiWriteMode).toBe("direct");
        expect(after?.entityRevision).toBe((before?.entityRevision ?? 0n) + 1n);
        // Stopping the pending switch is the writer's latest choice too.
        await runtime.app.delivery.withdrawControl(THREAD.threadId as never, switched.response.id);
        const [stopped] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));
        expect(stopped?.defaultAiWriteMode).toBe("draft");

        expect(await modeOf(SIBLING.threadId)).toBe("draft");
        const sibling = await runtimes.script(runtime, SIBLING).begin();
        expect((await create(sibling.call, "sibling")).result).toMatchObject({
          destination: "draft",
        });
      });
    });

    // D31: a create or copy would make its file in the archived Work's frozen drafts.
    it("refuses a draft-mode chat's create or copy into its archived Work with D31's copy", async () => {
      const script = await startWithChapter("Writer live content.");
      await db
        .update(schema.works)
        .set({ archivedAt: new Date() })
        .where(eq(schema.works.id, WORK_ID));
      const { call } = await script.begin();
      const frozen =
        'Work w1 is archived, so its drafts are frozen and this change wasn\'t made. Unarchive it with `work({"command":"unarchive","work":"w1"})`, or ask the user to switch this chat to auto-apply.';

      for (const args of [
        { command: "create", path: "manuscript://new", content: "Never lands." },
        { command: "copy", from: { path: CHAPTER }, path: "manuscript://copy" },
      ]) {
        const refused = await call("write", args);
        expect(refused.isError).toBe(true);
        expect(refused.result).toMatchObject({
          status: "permission_denied",
          reason: "work_archived",
        });
        expect(text(refused)).toContain(frozen);
      }
    });

    it("copies the section a #fragment names (D49)", async () => {
      const script = await startWithChapter(
        "# Opening\n\nDawn.\n\n# The Midnight Duel\n\nSteel rang.\n\n# Aftermath\n\nQuiet.",
      );
      const first = await script.begin();
      const bySection = await first.call("write", {
        command: "copy",
        from: { path: `${CHAPTER}.md#the-midnight-duel` },
        path: "scratch://duel",
      });
      expect(bySection.isError).toBeFalsy();
      expect(text(bySection)).toContain(`${CHAPTER}#the-midnight-duel`);
      expect(text(bySection)).not.toContain(".md");
      await first.save();

      const { call: next } = await script.begin();
      const duel = text(await next("read", { path: "scratch://duel" }));
      expect(duel).toContain("Steel rang.");
      expect(duel).not.toContain("Dawn.");
      expect(duel).not.toContain("Quiet.");
    });

    // I1: imported frontmatter travels with a model copy, so the copy is not a lesser document.
    it("carries the source's properties and aliases to a text copy", async () => {
      await db
        .update(schema.works)
        .set({ defaultAiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));
      const properties = {
        format: "yaml",
        text: "# kept as written\naliases: [Gate]\nstatus: revised\n",
      };
      await db
        .update(schema.documents)
        .set({ metadata: { properties, aliases: ["Gate"] } })
        .where(eq(schema.documents.id, DOC_ID));
      const script = await startWithChapter("Writer live content.");
      const { call } = await script.begin();

      // v1: the model never sees properties; it only copies them along.
      for (const seen of [
        await call("read", { path: CHAPTER }),
        await call("ls", { path: "manuscript://" }),
        await call("search", { pattern: "revised" }),
      ]) {
        expect(text(seen)).not.toContain("status: revised");
        expect(text(seen)).not.toContain("kept as written");
      }

      const copied = await call("write", {
        command: "copy",
        from: { path: CHAPTER },
        path: "manuscript://gate-copy",
      });

      expect(copied.isError).toBeFalsy();
      const [copy] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "gate-copy"));
      expect(copy?.metadata).toMatchObject({
        properties,
        aliases: ["Gate"],
        copiedFrom: { uri: CHAPTER },
      });
    });

    it("rolls a copy back with its reply", async () => {
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.threads.id, THREAD.threadId));
      const script = await startWithChapter("Writer live content.");
      const { call, responseId } = await script.begin();

      const copied = await call("write", {
        command: "copy",
        from: { path: CHAPTER },
        path: "manuscript://rolled-back",
      });
      expect(copied.isError).toBeFalsy();
      const documentId = (copied.metadata as { documentId?: unknown } | undefined)?.documentId;
      if (typeof documentId !== "string") throw new Error("the copy reported no documentId");

      const rolledBack = await script.runtime.ports.documentSync.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        THREAD as never,
      );

      expect(rolledBack.stagedCreates.discarded).toContain(documentId);
      const content = await script.runtime.ports.documentSync.readAsMarkdown(documentId);
      expect(content.ok ? content.value.trim() : "").toBe("");
    });

    // §12.5, O-11: a rolled-back reply retracts its draft create, unless another thread in
    // the Work already committed text to it.
    it("retracts a rolled-back reply's draft create unless another thread committed text to it (C-4)", async () => {
      const runtime = await runtimes.compose();
      const scenario = await branchTreeScenario(db, { runtime, runtimes });
      const work = await scenario.work("Retracting", "draft");
      const documentIdOf = (result: { metadata?: unknown }) => {
        const documentId = (result.metadata as { documentId?: unknown } | undefined)?.documentId;
        if (typeof documentId !== "string") throw new Error("the create reported no documentId");
        return documentId;
      };
      const rowOf = async (id: string) => {
        const [found] = await db
          .select({ hidden: schema.documents.hidden, deletedAt: schema.documents.deletedAt })
          .from(schema.documents)
          .where(eq(schema.documents.id, id));
        return found;
      };
      const usesOf = (id: string) =>
        db
          .select({ branchId: schema.branchTreeChanges.branchId })
          .from(schema.branchTreeChanges)
          .where(eq(schema.branchTreeChanges.nodeId, id));

      const alone = await scenario.model(work).reply();
      const aloneId = documentIdOf(
        await alone.call("write", {
          command: "create",
          path: "manuscript://lore/alone.md",
          content: "Never kept.",
        }),
      );
      await alone.rollback();
      expect.soft(await rowOf(aloneId), "retracted: tombstoned").toMatchObject({
        hidden: true,
        deletedAt: expect.any(Date),
      });
      expect.soft(await usesOf(aloneId), "retracted: no use left").toEqual([]);
      expect
        .soft(
          await db
            .select({
              status: schema.documentDrafts.status,
              cause: schema.documentDrafts.closedCause,
              state: schema.documentDrafts.state,
            })
            .from(schema.documentDrafts)
            .where(eq(schema.documentDrafts.documentId, aloneId)),
          "retracted: its drafts retained closed with bytes released",
        )
        .toEqual([
          expect.objectContaining({ status: "closed", cause: "discarded", state: Buffer.alloc(0) }),
          expect.objectContaining({ status: "closed", cause: "discarded", state: Buffer.alloc(0) }),
        ]);

      const other = await scenario.thread(work);
      const first = await scenario.model(work).reply();
      const sharedId = documentIdOf(
        await first.call("write", {
          command: "create",
          path: "manuscript://lore/shared.md",
          content: "The first thread's text.",
        }),
      );
      const second = await scenario.model(other).reply();
      await second.call("read", { path: "manuscript://lore/shared.md" });
      const inserted = await second.call("write", {
        command: "insert",
        path: "manuscript://lore/shared.md",
        content: "The second thread's line.",
      });
      expect.soft(inserted.isError ?? false, "the other thread writes").toBe(false);
      await second.save();
      await first.rollback();
      expect.soft(await rowOf(sharedId), "stands: still hidden and live").toMatchObject({
        hidden: true,
        deletedAt: null,
      });
      expect.soft(await usesOf(sharedId), "stands: the branch keeps it").toHaveLength(1);
      const read = await scenario.view(other).read("lore/shared.md");
      expect
        .soft(read.ok && read.value.content, "stands: the other thread's text")
        .toContain("The second thread's line.");

      // Two Works share one hidden identity: retracting A's create retires only A's peers.
      const workA = await scenario.work("Retracting A", "draft");
      const workB = await scenario.work("Surviving B", "draft");
      const replyA = await scenario.model(workA).reply();
      const twoWorkId = documentIdOf(
        await replyA.call("write", {
          command: "create",
          path: "manuscript://lore/two-works.md",
          content: "A's text, never kept.",
        }),
      );
      const replyB = await scenario.model(workB).reply();
      const joined = await replyB.call("write", {
        command: "create",
        path: "manuscript://lore/two-works.md",
        content: "B's unsaved contribution.",
      });
      expect.soft(documentIdOf(joined), "B joins A's hidden identity").toBe(twoWorkId);
      const bPeer = async () => {
        const [peer] = await db
          .select({ status: schema.documentDrafts.status })
          .from(schema.documentDrafts)
          .where(eq(schema.documentDrafts.threadId, workB.threadId));
        return peer?.status;
      };
      expect.soft(await bPeer(), "B's peer before A retracts").toBe("active");
      await replyA.rollback();
      expect.soft(await bPeer(), "B's peer survives A's retraction").toBe("active");
      const saved = (await replyB.save()) as { receipts?: readonly unknown[] };
      expect
        .soft(saved.receipts ?? [], "B's overlapping reply commits with a receipt")
        .toHaveLength(1);
      expect.soft(await rowOf(twoWorkId), "B keeps the identity").toMatchObject({
        hidden: true,
        deletedAt: null,
      });
      const readB = await scenario.view(workB).read("lore/two-works.md");
      expect
        .soft(readB.ok && readB.value.content, "B's saved text")
        .toContain("B's unsaved contribution.");
    });

    it("stages nothing for a write that leaves the chapter unchanged", async () => {
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.threads.id, THREAD.threadId));
      const script = await startWithChapter("Writer live content.");
      const { call } = await script.begin();

      const written = await call("write", {
        command: "create",
        path: CHAPTER,
        overwrite: true,
        content: "Writer live content.",
      });

      expect(written.isError).toBeFalsy();
      expect(text(written)).toContain("unchanged:");
      expect((written.metadata as { stagedWrite?: unknown } | undefined)?.stagedWrite).toBe(
        undefined,
      );
    });

    // D24 with 12b-Q2: a binary copy duplicates the stored object; in a draft-mode Work it
    // is the branch's own hidden row, never shared and not live.
    it("copies a binary file into the branch as its own hidden row and stored object", async () => {
      const runtime = await runtimes.compose();
      const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
      const put = await runtime.ports.objectStore.put(
        `uploads/${PROJECT_ID}/scan`,
        bytes,
        "application/pdf",
      );
      if (!put.ok) throw new Error(put.error.message);
      const written = await runtime.ports.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .writeBinary("manuscript://scan.pdf", {
          fileType: "pdf",
          storageUrl: put.value.storageUrl,
          mimeType: "application/pdf",
          sizeBytes: bytes.byteLength,
        });
      if (!written.ok) throw new Error(JSON.stringify(written.error));

      // Outside a reply, as a tool call with no model response.
      await bindEditAgent(runtime, THREAD.threadId);
      const copied = await runtime.app.toolExecutor.executeTool(
        {
          id: crypto.randomUUID(),
          name: "write",
          arguments: {
            command: "copy",
            from: { path: "manuscript://scan.pdf" },
            path: "kb://scan-copy.pdf",
          },
        },
        { ...THREAD, agentSlug: null },
      );

      expect(copied.result).toMatchObject({
        status: "success",
        destination: "draft",
        draftWork: "w1",
      });
      const [copy] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "scan-copy"));
      expect(copy?.hidden).toBe(true);
      expect(copy?.storageUrl).not.toBe(put.value.storageUrl);
      const created = await db
        .select({ branchId: schema.branchTreeChanges.branchId })
        .from(schema.branchTreeChanges)
        .where(eq(schema.branchTreeChanges.nodeId, copy?.id ?? ""));
      expect(created).toHaveLength(1);
      await expect(
        runtime.ports.contextPorts
          .forProject(PROJECT_ID, USER_ID, new Map())
          .stat("kb://scan-copy.pdf"),
      ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
      const key = copy?.storageUrl?.replace("object://meridian/", "") ?? "";
      const stored = await runtime.ports.objectStore.get(key);
      expect(stored.ok && [...stored.value.bytes]).toEqual([...bytes]);
    });
  });
}
