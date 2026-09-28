/** Undo controls restore durable history atomically without another provider call. */

import type { ControlBody, Turn } from "@meridian/contracts/threads";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCompactionFixture } from "./__tests__/compaction-db-fixture.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("compaction undo", () => {});
else
  describe("compaction undo", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 4 });
    beforeEach(() => truncateDrizzleTables(db, [schema.users]));
    afterAll(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.close();
    });
    const makeFixture = createCompactionFixture(db);
    type Rig = Awaited<ReturnType<typeof makeFixture>>;
    async function fixture(options: Parameters<typeof makeFixture>[0] = {}) {
      const rig = await makeFixture({
        history: "Earlier scene. ".repeat(100),
        gateway: scriptedGateway({ usage: { inputTokens: 100, outputTokens: 10 } }),
        ...options,
      });
      rig.setThreshold(100000);
      return rig;
    }
    async function enqueue(rig: Rig, control: ControlBody) {
      return rig.delivery.enqueueControl({
        threadId: rig.threadId,
        actorId: rig.ids.user,
        id: crypto.randomUUID(),
        control,
      });
    }
    async function drain(rig: Rig) {
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      const result = await run.execute();
      expect(["complete", "error"]).toContain(result.status);
      await expect.poll(async () => (await rig.runClaim.read(rig.threadId)).kind).toBe("asleep");
      return rig.repos.turns.listByThread(rig.threadId);
    }
    async function compact(rig: Rig) {
      await enqueue(rig, { kind: "compact" });
      const turns = await drain(rig);
      const c = turns.at(-1)!;
      expect(c).toMatchObject({ role: "compaction", status: "complete" });
      return c;
    }
    const undo = (rig: Rig, c: Turn) =>
      enqueue(rig, { kind: "compaction_undo", compactionTurnId: c.id });
    const marker = (turns: Turn[]) =>
      [...turns]
        .reverse()
        .find((t) => (t.metadata as { kind?: string })?.kind === "compaction_undo")!;

    it("C6b sixth pinned request restores pre-C messages and prior bake", async () => {
      const rig = await fixture();
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "Before the cut.",
      });
      await run.execute();
      const before = rig.gateway.requests[0];
      const oldBake = (await rig.repos.threads.findById(rig.threadId))!.initialPromptBakeId;
      const render = rig.deps.workContext.renderForThread;
      rig.deps.workContext.renderForThread = async (id) => ({
        ...(await render(id)),
        text: "Changed Work at C",
      });
      const c = await compact(rig);
      expect(c.promptBakeId).not.toBe(oldBake);
      await (
        await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "Post-C turn before undo.",
        })
      ).execute();
      await undo(rig, c);
      const turns = await drain(rig);
      expect(marker(turns)).toMatchObject({ status: "complete", promptBakeId: oldBake });
      expect(rig.gateway.requests).toHaveLength(2);
      const next = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        userText: "After undo.",
      });
      await next.execute();
      const restored = rig.gateway.requests.at(-1)!;
      expect(restored.messages.slice(0, before.messages.length)).toEqual(before.messages);
      expect(JSON.stringify(restored.messages)).toContain(
        "The writer undid the compaction here. The earlier conversation above is restored.",
      );
      expect(
        JSON.stringify(
          {
            messages: restored.messages,
            tools: restored.tools,
            model: restored.model,
            promptCacheKey: "<thread-id>",
          },
          null,
          2,
        ),
      ).toMatchSnapshot("sixth pinned request: undo");
      expect(JSON.stringify(restored.messages)).toContain("Post-C turn before undo.");
      expect(restored.messages[0]).toEqual(before.messages[0]);
      expect(rig.summarizer.calls).toHaveLength(1);
      const { createDrizzleEventJournalReader } = await import("../../threads/index.js");
      const journal = await createDrizzleEventJournalReader(db).listByThread(rig.threadId);
      expect(
        journal
          .filter(
            (row) =>
              row.payload.type === "turn.created" && row.payload.turn.id === marker(turns).id,
          )
          .map((row) => row.payload.type === "turn.created" && row.payload.turn.status),
      ).toEqual(["complete"]);
    });
    it("C6b refusal has no block and preserves the compacted prefix", async () => {
      const rig = await fixture({ history: "Earlier scene. ".repeat(1500) });
      const c = await compact(rig);
      await (
        await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "Compacted conversation",
        })
      ).execute();
      const before = rig.gateway.requests.at(-1)!;
      rig.setThreshold(2500);
      await undo(rig, c);
      const u = marker(await drain(rig));
      expect(u).toMatchObject({
        status: "error",
        error: "Undo would make this conversation compact again immediately.",
        metadata: { reason: "would_recompact" },
        promptBakeId: null,
      });
      expect(await rig.repos.blocks.listByTurn(u.id)).toEqual([]);
      const { createDrizzleEventJournalReader } = await import("../../threads/index.js");
      const journal = await createDrizzleEventJournalReader(db).listByThread(rig.threadId);
      expect(
        journal.find((row) => row.payload.type === "turn.error" && row.payload.turn.id === u.id)
          ?.payload,
      ).toMatchObject({
        type: "turn.error",
        error: {
          code: "would_recompact",
          message: "Undo would make this conversation compact again immediately.",
          details: { reason: "would_recompact" },
        },
      });

      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Continue compacted" })
      ).execute();
      const after = rig.gateway.requests.at(-1)!;
      expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
      expect(JSON.stringify(after.messages)).not.toContain("The writer undid");
      expect(rig.summarizer.calls).toHaveLength(1);
    });
    it("C6b undo twice gives already_undone", async () => {
      const rig = await fixture();
      const c = await compact(rig);
      await undo(rig, c);
      await drain(rig);
      await undo(rig, c);
      expect(marker(await drain(rig))).toMatchObject({
        status: "error",
        error: "This compaction has already been undone.",
        metadata: { reason: "already_undone" },
      });
    });
    it("C6b A C B undo uses A usage never B", async () => {
      const gateway = scriptedGateway({ usage: { inputTokens: 100, outputTokens: 10 } });
      const rig = await fixture({ gateway, history: "Large original request. ".repeat(1500) });
      await (await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "A" })).execute();
      const c = await compact(rig);
      await (await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "B" })).execute();
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const b = turns.at(-1)!;
      const responses = await rig.repos.modelResponses.listByTurn(b.id);
      const { eq } = await import("drizzle-orm");
      await db
        .update(schema.modelResponses)
        .set({ inputTokens: 100000 })
        .where(eq(schema.modelResponses.id, responses[0].id));
      rig.setThreshold(2500);
      await undo(rig, c);
      expect(marker(await drain(rig)).status).toBe("complete");
    });
    it("C6b compact undo M executes C U B before answering M", async () => {
      let rig: Rig;
      rig = await fixture({
        summarizer: scriptedSummarizer(async ({ turnId }) => {
          await enqueue(rig, { kind: "compaction_undo", compactionTurnId: turnId });
          await rig.send(rig.threadId, "M after controls");
          return { kind: "complete", text: "Summary", model: "summary-model", modelResponses: [] };
        }),
      });
      await enqueue(rig, { kind: "compact" });
      const turns = await drain(rig);
      const u = marker(turns);
      expect(u.status).toBe("complete");
      expect(turns.at(-1)?.role).toBe("assistant");
      expect(JSON.stringify(rig.gateway.requests[0].messages)).toContain("M after controls");
      expect(JSON.stringify(rig.gateway.requests[0].messages)).not.toContain(
        "Conversation summary.",
      );
    });
    it("C6b auto summary folds undo and late message into C U B", async () => {
      let rig: Rig;
      rig = await fixture({
        history: "Earlier scene. ".repeat(1500),
        summarizer: scriptedSummarizer(async ({ turnId }) => {
          rig.setThreshold(100000);
          await enqueue(rig, { kind: "compaction_undo", compactionTurnId: turnId });
          await rig.send(rig.threadId, "Late M");
          return { kind: "complete", text: "Summary", model: "summary-model", modelResponses: [] };
        }),
      });
      rig.setThreshold(2500);
      await rig.send(rig.threadId, "Trigger C");
      const turns = await drain(rig);
      expect(marker(turns).status).toBe("complete");
      expect(rig.gateway.requests).toHaveLength(1);
      expect(JSON.stringify(rig.gateway.requests[0].messages)).toContain("Earlier scene.");
    });
    it("C6b C2 then C1 restores whole history", async () => {
      const rig = await fixture();
      const c1 = await compact(rig);
      await (
        await rig.orchestrator.prepare({
          threadId: rig.threadId,
          userText: "New history for second cut. ".repeat(100),
        })
      ).execute();
      const c2 = await compact(rig);
      await undo(rig, c2);
      await drain(rig);
      await undo(rig, c1);
      expect(marker(await drain(rig)).status).toBe("complete");
      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Continue restored" })
      ).execute();
      expect(JSON.stringify(rig.gateway.requests.at(-1)!.messages)).toContain("Earlier scene.");
      expect(JSON.stringify(rig.gateway.requests.at(-1)!.messages)).not.toContain(
        "Conversation summary.",
      );
    });

    it("C6b post-C image eviction discards A baseline and estimates the whole request", async () => {
      const rig = await fixture({ history: "Large original request. ".repeat(1000) });
      await (await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "A" })).execute();
      const c = await compact(rig);
      await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: c.id,
        role: "system",
        origin: "system",
        status: "complete",
        metadata: {
          kind: "system_update",
          section: "image_inclusion",
          breaks: [
            { blockId: "prior-image", uri: "scratch://picture.png", reason: "budget_eviction" },
          ],
        },
      });
      rig.setThreshold(2500);
      await undo(rig, c);
      expect(marker(await drain(rig))).toMatchObject({
        status: "error",
        error: "Undo would make this conversation compact again immediately.",
        metadata: { reason: "would_recompact" },
      });
    });

    it("C6b inherited C is not_active and fork cutoffs isolate U", async () => {
      const { loadThreadConversationContext } = await import("../../threads/index.js");
      const { projectActiveHistory } = await import("./compaction/index.js");
      const { prepareCompactionUndo } = await import("./compaction-undo.js");
      const rig = await fixture();
      const c = await compact(rig);
      const source = (await rig.repos.threads.findById(rig.threadId))!;
      async function fork(cut: Turn) {
        return (
          await rig.repos.threads.createDerivedPrimary({
            id: crypto.randomUUID(),
            source,
            workId: source.workId,
            userId: source.userId,
            projectId: source.projectId,
            originType: "fork",
            originTurnId: cut.id,
            initialPromptBakeId: cut.promptBakeId,
          })
        ).thread;
      }
      const between = await fork(c);
      await undo(rig, c);
      const u = marker(await drain(rig));
      const after = await fork(u);
      const beforeView = await loadThreadConversationContext(rig.repos, between);
      const afterView = await loadThreadConversationContext(rig.repos, after);
      expect(
        JSON.stringify(projectActiveHistory(beforeView.turns, beforeView.blocks, between.ref)),
      ).toContain("Conversation summary.");
      expect(
        JSON.stringify(projectActiveHistory(afterView.turns, afterView.blocks, after.ref)),
      ).toContain("Earlier scene.");
      expect(
        JSON.stringify(projectActiveHistory(afterView.turns, afterView.blocks, after.ref)),
      ).not.toContain("Conversation summary.");
      const control = {
        id: crypto.randomUUID(),
        threadId: between.id,
        seq: 1,
        intent: "control" as const,
        provenance: { kind: "writer" as const, actorId: rig.ids.user },
        body: { kind: "compaction_undo" as const, compactionTurnId: c.id },
        idempotencyKey: "inherited",
        enqueuedAt: new Date().toISOString(),
        deliveredAt: null,
      };
      const prepared = await prepareCompactionUndo({
        deps: rig.deps,
        thread: between,
        ...beforeView,
        control,
        assemble: async () => {
          throw new Error("Inherited undo must never assemble");
        },
      });
      expect(prepared.turn).toMatchObject({
        status: "error",
        error: "Only the active compaction in this chat can be undone.",
        metadata: { reason: "not_active" },
      });
      await expect(
        rig.delivery.enqueueControl({
          threadId: between.id,
          actorId: rig.ids.user,
          id: crypto.randomUUID(),
          control: control.body,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("C6b C image re-admission stops applying after U", async () => {
      const { revertedCompactionIds } = await import("../../threads/index.js");
      const rig = await fixture();
      const prior = (await rig.repos.turns.listByThread(rig.threadId)).at(-1)!;
      const image = await rig.repos.blocks.create({
        turnId: prior.id,
        blockType: "image",
        sequence: 1,
        content: {
          type: "image_reference",
          documentId: crypto.randomUUID(),
          uri: "scratch://picture.png",
        },
        status: "complete",
      });
      await rig.repos.imageInclusions.set({
        threadId: rig.threadId,
        blockId: image.id,
        decisionTurnId: prior.id,
        included: false,
      });
      const c = await compact(rig);
      await rig.repos.imageInclusions.set({
        threadId: rig.threadId,
        blockId: image.id,
        decisionTurnId: c.id,
        included: true,
      });
      expect(
        (await rig.repos.imageInclusions.findByThread(rig.threadId)).find(
          (row) => row.blockId === image.id,
        )?.included,
      ).toBe(true);
      await undo(rig, c);
      const turns = await drain(rig);
      expect(marker(turns).status).toBe("complete");
      expect(
        (
          await rig.repos.imageInclusions.findByThread(rig.threadId, revertedCompactionIds(turns))
        ).find((row) => row.blockId === image.id),
      ).toMatchObject({ included: false, decisionTurnId: prior.id });
    });

    it("C6b a document edited after C is elided by U from raw restored history", async () => {
      const { writeDocumentText } = await import("../tools/document-text.js");
      const { projectActiveHistory } = await import("./compaction/index.js");
      const rig = await fixture();
      rig.deps.toolRegistry.register({
        source: "core",
        definition: { type: "function", name: "write", description: "write", inputSchema: {} },
        execution: { type: "server", handler: async () => null },
        documentText: writeDocumentText,
      });
      const prior = (await rig.repos.turns.listByThread(rig.threadId)).at(-1)!;
      await rig.repos.blocks.create({
        turnId: prior.id,
        blockType: "tool_use",
        sequence: 1,
        status: "complete",
        content: {
          toolCallId: "read",
          toolName: "write",
          input: { command: "read", path: "manuscript://chapter.md" },
        },
      });
      const read = await rig.repos.blocks.create({
        turnId: prior.id,
        blockType: "tool_result",
        sequence: 2,
        status: "complete",
        content: {
          toolCallId: "read",
          toolName: "write",
          output: "STALE CHAPTER TEXT",
          metadata: {
            documentRevisions: [
              { documentId: "chapter", uri: "manuscript://chapter.md", revision: "old" },
            ],
          },
        },
      });
      rig.deps.documentRevisions.current = async ({ documentIds }) =>
        new Map(documentIds.map((id) => [id, "old"]));
      const c = await compact(rig);
      rig.deps.documentRevisions.current = async ({ documentIds }) =>
        new Map(documentIds.map((id) => [id, "new"]));
      await undo(rig, c);
      const turns = await drain(rig);
      expect(marker(turns)).toMatchObject({
        status: "complete",
        metadata: { elisions: [expect.objectContaining({ blockId: read.id })] },
      });
      const blocks = await rig.repos.blocks.listByThread(rig.threadId);
      expect(JSON.stringify(projectActiveHistory(turns, blocks, "p1"))).not.toContain(
        "STALE CHAPTER TEXT",
      );
      expect((await rig.repos.blocks.findById(read.id))?.content).toMatchObject({
        output: "STALE CHAPTER TEXT",
      });
    });

    it("C6b undo adopting a parent message admits on B never U", async () => {
      const rig = await fixture({ child: true });
      const c = await compact(rig);
      await undo(rig, c);
      const parentMessage = await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "message",
        provenance: { kind: "agent", threadId: rig.ids.caller },
        body: { kind: "text", text: "Parent follow-up" },
        idempotencyKey: "parent",
      });
      const turns = await drain(rig);
      const b = turns.at(-1)!;
      expect(turns.find((t) => t.id === parentMessage.id)!.position).toBeGreaterThan(
        marker(turns).position,
      );
      expect(marker(turns).status).toBe("complete");
      expect(b.role).toBe("assistant");
      expect(await rig.repos.executionReports.findByExecution(rig.threadId, b.id)).toMatchObject({
        terminalTurnId: b.id,
      });
      expect(
        await rig.repos.executionReports.findByExecution(rig.threadId, marker(turns).id),
      ).toBeNull();
    });

    it("C6b snapshot advisory follows current trigger and active local C", async () => {
      const { createCompactionUndoReader } = await import("./compaction-undo.js");
      const { buildThreadSnapshot, createThreadEventHub, createDrizzleEventJournalReader } =
        await import("../../threads/index.js");
      const rig = await fixture();
      const c = await compact(rig);
      const hub = createThreadEventHub({
        journalWriter: rig.eventWriter,
        journalReader: createDrizzleEventJournalReader(db),
        eventSink: rig.deps.eventSink,
      });
      const readers = {
        ...rig.runClaim,
        readPending: async () => ({ items: [] }),
        readCompactionUndo: createCompactionUndoReader(rig.deps),
      };
      expect(
        (await buildThreadSnapshot(rig.repos, hub, readers, rig.threadId)).compactionUndo,
      ).toEqual({ turnId: c.id, availability: "likely" });
      rig.setThreshold(100);
      expect(
        (await buildThreadSnapshot(rig.repos, hub, readers, rig.threadId)).compactionUndo,
      ).toEqual({ turnId: c.id, availability: "would_recompact" });
      rig.setThreshold(100000);
      await undo(rig, c);
      await drain(rig);
      expect(
        (await buildThreadSnapshot(rig.repos, hub, readers, rig.threadId)).compactionUndo,
      ).toBeNull();
    });

    it("C6b live undo commit failure rolls back and lands undo_failed with M answered", async () => {
      const { currentDrizzleDb } = await import("../../../shared/drizzle-transaction.js");
      const rig = await fixture();
      const c = await compact(rig);
      const find = rig.repos.promptBakes.findById;
      let failed = false;
      rig.repos.promptBakes.findById = async (id) => {
        if (!failed && currentDrizzleDb(db) !== db) {
          failed = true;
          throw new Error("lost bake read in U commit");
        }
        return find(id);
      };
      await undo(rig, c);
      await rig.send(rig.threadId, "M survives undo failure");
      const turns = await drain(rig);
      expect(failed).toBe(true);
      expect(marker(turns)).toMatchObject({
        status: "error",
        error: "This compaction couldn't be undone. Try again.",
        metadata: { reason: "undo_failed" },
        promptBakeId: null,
      });
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(rig.summarizer.calls).toHaveLength(1);
    });

    it("C6b review preparation failure leaves U not a fake C", async () => {
      const rig = await fixture();
      const c = await compact(rig);
      const list = rig.deps.gateway.listModels!;
      rig.deps.gateway.listModels = () => {
        throw new Error("model resolver unavailable");
      };
      await undo(rig, c);
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      await run.execute();
      rig.deps.gateway.listModels = list;
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(marker(turns)).toMatchObject({
        status: "error",
        error: "This compaction couldn't be undone. Try again.",
        metadata: { reason: "undo_failed" },
      });
      expect(turns.filter((t) => t.role === "compaction")).toHaveLength(1);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
    });
    it("C6b review terminal undo acknowledges notices and settles the session", async () => {
      const rig = await fixture();
      const c = await compact(rig);
      await rig.delivery.enqueue({
        threadId: rig.threadId,
        intent: "notice",
        provenance: { kind: "system", source: "test" },
        body: { kind: "context", parts: [{ source: "test", text: "Before undo notice" }] },
        idempotencyKey: "notice",
      });
      await undo(rig, c);
      await drain(rig);
      expect(await rig.delivery.selectPending(rig.threadId)).toEqual([]);
      expect(rig.activeRuns()).toBe(0);
    });
    it("C6b review unavailable model keeps the snapshot readable", async () => {
      const { createCompactionUndoReader } = await import("./compaction-undo.js");
      const rig = await fixture();
      await compact(rig);
      const thread = (await rig.repos.threads.findById(rig.threadId))!;
      rig.deps.gateway.listModels = () => [];
      expect(
        await createCompactionUndoReader(rig.deps)(
          thread,
          await rig.repos.turns.listByThread(rig.threadId),
        ),
      ).toBeNull();
    });
    it("C6b review refused undo still compacts the ordinary oversized continuation", async () => {
      const rig = await fixture();
      const c = await compact(rig);
      await undo(rig, c);
      const grown = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: c.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await rig.repos.blocks.create({
        turnId: grown.id,
        blockType: "text",
        sequence: 0,
        textContent: "Long generated answer. ".repeat(1500),
        content: "Long generated answer. ".repeat(1500),
        status: "complete",
      });
      await rig.send(rig.threadId, "Continue");
      rig.setThreshold(3000);
      const turns = await drain(rig);
      expect(marker(turns)).toMatchObject({
        status: "error",
        error: "Undo would make this conversation compact again immediately.",
        metadata: { reason: "would_recompact" },
      });
      expect(turns.filter((t) => t.role === "compaction")).toHaveLength(2);
    });
    it("C6b review immediate undo does not readmit C images", async () => {
      let rig: Rig;
      rig = await fixture({
        summarizer: scriptedSummarizer(async ({ turnId }) => {
          await enqueue(rig, { kind: "compaction_undo", compactionTurnId: turnId });
          await rig.send(rig.threadId, "Continue without excluded image");
          return { kind: "complete", text: "Summary", model: "summary-model", modelResponses: [] };
        }),
      });
      const previous = (await rig.repos.turns.listByThread(rig.threadId)).at(-1)!;
      const user = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: previous.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await rig.repos.blocks.create({
        turnId: user.id,
        blockType: "text",
        sequence: 0,
        content: "Image message",
        textContent: "Image message",
        status: "complete",
      });
      const image = await rig.repos.blocks.create({
        turnId: user.id,
        blockType: "image",
        sequence: 1,
        content: {
          type: "image_reference",
          documentId: crypto.randomUUID(),
          uri: "scratch://excluded.png",
        },
        status: "complete",
      });
      await rig.repos.imageInclusions.set({
        threadId: rig.threadId,
        blockId: image.id,
        decisionTurnId: user.id,
        included: false,
      });
      rig.deps.imageAssets.resolve = async () => ({
        mediaType: "image/png",
        data: "excluded-image",
        sizeBytes: 100,
      });
      await enqueue(rig, { kind: "compact" });
      await drain(rig);
      expect(
        rig.gateway.requests
          .at(-1)!
          .messages.flatMap((m) => m.content)
          .filter((p) => p.type === "image"),
      ).toEqual([]);
    });

    it("C6b tool boundary undo continues the same task under restored history", async () => {
      let rig: Rig;
      let c: Turn;
      const gateway = scriptedGateway({
        onStream: async (call) => {
          if (call === 1) await undo(rig, c);
        },
        results: [
          {
            content: [
              {
                type: "tool_use",
                toolCallId: "tool-before-undo",
                toolName: "unavailable_probe_tool",
                input: {},
              },
            ],
            toolCalls: [],
            finishReason: "tool_use",
            usage: { inputTokens: 100, outputTokens: 10 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        ],
      });
      rig = await fixture({ gateway });
      c = await compact(rig);
      await (
        await rig.orchestrator.prepare({ threadId: rig.threadId, userText: "Continue the task" })
      ).execute();
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.slice(-3).map((t) => (t.metadata as { kind?: string })?.kind ?? t.role)).toEqual(
        ["assistant", "compaction_undo", "assistant"],
      );
      expect(marker(turns).status).toBe("complete");
      expect(gateway.requests).toHaveLength(2);
      expect(JSON.stringify(gateway.requests[1].messages)).toContain("Earlier scene.");
      expect(JSON.stringify(gateway.requests[1].messages)).not.toContain("Conversation summary.");
    });

    it("C6b an oversized reply does not overwrite an undo refusal", async () => {
      const rig = await fixture();
      const c = await compact(rig);
      await undo(rig, c);
      await rig.send(rig.threadId, "Cannot fit this pin ".repeat(1000));
      rig.setThreshold(2500);
      await (await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true })).execute();
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(marker(turns)).toMatchObject({
        status: "error",
        error: "Undo would make this conversation compact again immediately.",
        metadata: { reason: "would_recompact" },
      });
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "error" });
    });

    it("C6b a queued undo cannot hide a missing activated skill", async () => {
      const rig = await fixture();
      const c = await compact(rig);
      await undo(rig, c);
      await rig.send(rig.threadId, "Use the selected skill", {
        activatedSkillSlugs: ["missing-skill"],
      });
      const run = await rig.orchestrator.prepare({ threadId: rig.threadId, drain: true });
      await run.execute();
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(marker(turns)).toMatchObject({
        status: "error",
        error: "This compaction couldn't be undone. Try again.",
        metadata: { reason: "undo_failed" },
      });
      expect(turns.at(-1)).toMatchObject({ role: "assistant", status: "error" });
      expect(rig.gateway.requests).toHaveLength(0);
    });
  });
