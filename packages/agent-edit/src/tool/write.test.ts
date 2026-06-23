// End-to-end write(command=...) coverage with in-memory port fakes.
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { mdxCodec } from "../codec/presets/mdx.js";
import { createAgentEditCore } from "../index.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type DocumentCoordinator, DocumentNotFoundError } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  UpdateJournal,
} from "../ports/update-journal.js";
import { InMemoryAgentEditJournal } from "../test-support/index.js";
import { createUndoManagerRegistry } from "../undo/manager-registry.js";
import type { WriteContext, WriteOutcome, WriteStatus } from "./types.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);
const THREAD_ID = "thread-a";
const context: WriteContext = { sessionId: "session-a", threadId: THREAD_ID };
const REVERSAL_CLIENT_ID = 9_999;

describe("write tool dispatch", () => {
  it("views block-hashed document content and scoped outline sections", async () => {
    const ctx = harness({ "chapter.md": "# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits." });

    const full = await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    expectOutcome(full, "success");
    expect(outcomeText(full)).toMatch(/^[0-9a-f]{4}\|# Chapter/m);
    expect(outcomeText(full)).toContain("|Alpha sword.");

    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const section = await ctx.core.write(
      { command: "view", file: `chapter.md#${headingHash}` },
      context,
    );
    expect(outcomeText(section)).toContain("|## Arena");
    expect(outcomeText(section)).toContain("|Beta waits.");

    const outline = await ctx.core.write(
      { command: "view", file: "chapter.md", format: "outline" },
      context,
    );
    expect(outcomeText(outline)).toContain(
      `write(command="view", file="chapter.md#${headingHash}")`,
    );
  });

  it("creates a document with initial content", async () => {
    const ctx = harness();
    ctx.coordinator.createEmpty("new.md");

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expectOutcome(result, "success");
    expect(outcomeText(result)).toContain("|# Draft");
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
  });

  it("creates a new file through DocumentLifecycle and persists the journal update", async () => {
    const ctx = harness();

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
    expect(
      renderedBlockBodies(await ctx.core.write({ command: "view", file: "new.md" }, context)),
    ).toEqual(["# Draft", "Opening line."]);

    const snapshot = await ctx.journal.read("new.md");
    expect(ctx.journal.appendBatchCalls).toBe(1);
    expect(snapshot.checkpoint).toBeNull();
    expect(snapshot.updates).toHaveLength(1);
    const replayed = new Y.Doc({ gc: false });
    for (const update of snapshot.updates) Y.applyUpdate(replayed, update.update);
    expect(blockTexts(replayed)).toEqual(["Draft", "Opening line."]);
  });

  it("stages create and commits it through the response batch path", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create",
      responseId: "response-staged-create",
    };

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      responseContext,
    );

    expect(outcomeText(result)).toContain("status: success");
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(0);
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);

    const commit = await ctx.core.commitResponse("response-staged-create");

    expect(commit.stagedCreates).toEqual({ committed: ["new.md"], discarded: [] });
    expect(ctx.journal.appendBatchCalls).toBe(1);
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
  });

  it("rolls back staged create without leaving an empty live document", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create-rollback",
      responseId: "response-staged-create-rollback",
    };

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      responseContext,
    );

    expectOutcome(result, "success");
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(0);
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);

    const rollback = await ctx.core.rollbackResponse("response-staged-create-rollback");

    expect(rollback.stagedCreates).toEqual({ committed: [], discarded: ["new.md"] });
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(0);
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);
    expect(outcomeText(await ctx.core.write({ command: "view", file: "new.md" }, context))).toBe(
      'status: document_not_found\n\nFile not found. Check the path, or use write(command="create", file="new.md") to make a new one.',
    );
  });

  it("reports a staged create as discarded when invalidation drops its response buffer", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create-invalidated",
      responseId: "response-staged-create-invalidated",
    };

    await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      responseContext,
    );
    ctx.core.invalidateThread("new.md", THREAD_ID);

    const commit = await ctx.core.commitResponse("response-staged-create-invalidated");

    expect(commit).toMatchObject({
      documentCount: 0,
      updateCount: 0,
      stagedCreates: { committed: [], discarded: ["new.md"] },
    });
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(0);
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);
    await expect(ctx.core.commitResponse("response-staged-create-invalidated")).resolves.toEqual({
      responseId: "response-staged-create-invalidated",
      documentCount: 0,
      updateCount: 0,
      documents: [],
      stagedCreates: { committed: [], discarded: [] },
    });
  });

  it("rejects create for an existing non-empty file", async () => {
    const ctx = harness({ "chapter.md": "Already here." });

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Replacement." },
      context,
    );

    expect(outcomeText(result)).toContain("status: invalid_write");
    expectOutcome(result, "invalid_write", true);
    expect(outcomeText(result)).toContain("File already exists: chapter.md");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Already here."]);
  });

  it("returns a clean unsupported error when create has no lifecycle", async () => {
    const ctx = harness({}, { lifecycle: false });

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "Draft." },
      context,
    );

    expect(outcomeText(result)).toContain("status: invalid_write");
    expect(outcomeText(result)).toContain("document creation is not supported by this deployment");
  });

  it("inserts by block hash, by find, and deduplicates tool_use_id", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nOmega." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const byHash = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Inserted scene.", after: alphaHash },
      context,
    );

    expect(outcomeText(byHash)).toContain("status: success");
    expect(outcomeText(byHash)).toContain("Inserted scene.");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Inserted scene.", "Omega."]);

    const first = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "Alpha",
        tool_use_id: "same-call",
      },
      context,
    );
    const replay = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "Alpha",
        tool_use_id: "same-call",
      },
      context,
    );

    expect(replay).toBe(first);
    expectOutcome(first, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha!.");
  });

  it("stages multiple response writes and commits journal plus live doc once", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-response-staging",
      responseId: "response-staging",
    };
    let liveUpdateCount = 0;
    ctx.liveDoc("chapter.md").on("update", () => {
      liveUpdateCount += 1;
    });

    const first = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    const second = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Gamma." },
      responseContext,
    );
    const third = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Delta." },
      responseContext,
    );

    expect(outcomeText(first)).toContain("Beta.");
    expect(outcomeText(second)).toContain("Beta.");
    expect(outcomeText(second)).toContain("Gamma.");
    expect(outcomeText(third)).toContain("Gamma.");
    expect(outcomeText(third)).toContain("Delta.");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    expect(liveUpdateCount).toBe(0);

    const commit = await ctx.core.commitResponse("response-staging");

    expect(commit).toMatchObject({
      responseId: "response-staging",
      documentCount: 1,
      updateCount: 3,
      documents: [{ documentId: "chapter.md", updateCount: 3 }],
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(3);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma.", "Delta."]);
    expect(liveUpdateCount).toBe(1);
    const firstCommitMutations = ctx.journal.mutationRecords("chapter.md");
    expect(firstCommitMutations.map((record) => record.wId)).toEqual([1, 2, 3]);
    expect(firstCommitMutations.map((record) => record.createdSeq)).toEqual(
      (await ctx.journal.read("chapter.md")).updates.map((update) => update.seq),
    );
    expect(
      ctx.undoRegistry.getState("chapter.md", THREAD_ID)?.undoStack.map((item) => item.wId),
    ).toEqual([1, 2, 3]);

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Epsilon." },
      {
        ...context,
        turnId: "turn-response-staging-next",
        responseId: "response-staging-next",
      },
    );
    await ctx.core.commitResponse("response-staging-next");
    expect(ctx.journal.mutationRecords("chapter.md").map((record) => record.wId)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("preserves cross-document response staging order in the derived journal batch", async () => {
    const ctx = harness({ "alpha.md": "Alpha.", "beta.md": "One." });
    await ctx.core.write({ command: "view", file: "alpha.md" }, context);
    await ctx.core.write({ command: "view", file: "beta.md" }, context);
    const responseId = "response-cross-doc-order";

    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "A1." },
      { ...context, responseId, turnId: "turn-alpha-1" },
    );
    await ctx.core.write(
      { command: "insert", file: "beta.md", content: "B1." },
      { ...context, responseId, turnId: "turn-beta-1" },
    );
    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "A2." },
      { ...context, responseId, turnId: "turn-alpha-2" },
    );
    await ctx.core.write(
      { command: "insert", file: "beta.md", content: "B2." },
      { ...context, responseId, turnId: "turn-beta-2" },
    );

    await ctx.core.commitResponse(responseId);

    expect(ctx.journal.appendBatchEntryOrders.at(-1)).toEqual([
      "alpha.md:turn-alpha-1",
      "beta.md:turn-beta-1",
      "alpha.md:turn-alpha-2",
      "beta.md:turn-beta-2",
    ]);
    expect(ctx.journal.mutationRecords("alpha.md").map((record) => record.wId)).toEqual([1, 2]);
    expect(ctx.journal.mutationRecords("beta.md").map((record) => record.wId)).toEqual([1, 2]);
  });

  it("returns cumulative staged echoes for text writes at the tool-response level", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-text-echo",
      responseId: "response-staged-text-echo",
    };

    const first = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Beta" },
      responseContext,
    );
    const second = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      responseContext,
    );
    const third = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "waits", content: "marches" },
      responseContext,
    );

    expect(outcomeText(first)).toMatch(/^[0-9a-f]{4}\|Beta sword waits\.$/m);
    expect(outcomeText(second)).toMatch(/^[0-9a-f]{4}\|Beta blade waits\.$/m);
    expect(outcomeText(third)).toMatch(/^[0-9a-f]{4}\|Beta blade marches\.$/m);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword waits."]);

    await ctx.core.commitResponse("response-staged-text-echo");

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Beta blade marches."]);
  });

  it("flips mutation status when undoing and redoing a turn", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-mutation-status" },
    );

    expect(ctx.journal.mutationRecords("chapter.md")).toMatchObject([
      {
        wId: 1,
        turnId: "turn-mutation-status",
        status: "active",
        createdSeq: 1,
      },
    ]);
    expect(ctx.undoRegistry.getState("chapter.md", THREAD_ID)?.undoStack).toMatchObject([
      { turnId: "turn-mutation-status", wId: 1 },
    ]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(outcomeText(undo)).toContain("status: reversed");
    expect(ctx.journal.mutationRecords("chapter.md")).toMatchObject([
      {
        wId: 1,
        turnId: "turn-mutation-status",
        status: "reversed",
        undoUpdateSeq: 2,
        reversedBy: "agent",
      },
    ]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toContain("status: reversed");
    expect(ctx.journal.mutationRecords("chapter.md")).toMatchObject([
      {
        wId: 1,
        turnId: "turn-mutation-status",
        status: "active",
      },
    ]);
    expect(ctx.journal.mutationRecords("chapter.md")[0]?.undoUpdateSeq).toBeUndefined();
    expect(ctx.journal.mutationRecords("chapter.md")[0]?.reversedBy).toBeUndefined();
  });

  it("scopes same-turn mutation status flips to the reversal being redone", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    const turnContext = { ...context, turnId: "turn-interleaved-status" };
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
      turnContext,
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const [firstMutation] = ctx.journal.mutationRecords("chapter.md");
    const firstUndoSeq = firstMutation?.undoUpdateSeq;
    expect(firstMutation).toMatchObject({
      wId: 1,
      status: "reversed",
      undoUpdateSeq: expect.any(Number),
    });

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      turnContext,
    );
    expect(ctx.journal.mutationRecords("chapter.md")).toMatchObject([
      { wId: 1, status: "reversed", undoUpdateSeq: firstUndoSeq },
      { wId: 2, status: "active" },
    ]);

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const afterSecondUndo = ctx.journal.mutationRecords("chapter.md");
    const secondUndoSeq = afterSecondUndo[1]?.undoUpdateSeq;
    expect(afterSecondUndo).toMatchObject([
      { wId: 1, status: "reversed", undoUpdateSeq: firstUndoSeq },
      { wId: 2, status: "reversed", undoUpdateSeq: expect.any(Number) },
    ]);
    expect(secondUndoSeq).not.toBe(firstUndoSeq);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoTurnId: "turn-interleaved-status",
    });

    await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    const afterRedo = ctx.journal.mutationRecords("chapter.md");
    expect(afterRedo).toMatchObject([
      { wId: 1, status: "reversed", undoUpdateSeq: firstUndoSeq },
      { wId: 2, status: "active" },
    ]);
    expect(afterRedo[1]?.undoUpdateSeq).toBeUndefined();
    expect(afterRedo[1]?.reversedBy).toBeUndefined();
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-interleaved-status",
    });
  });

  it("cold undo reverses only the active subset inside a reused turn id", async () => {
    const turnId = "turn-cold-active-subset";

    async function setup(ctx: ReturnType<typeof harness>) {
      const turnContext = { ...context, turnId };
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
        turnContext,
      );
      expect(
        outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
      ).toContain("status: reversed");
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        turnContext,
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
      expect(ctx.journal.mutationRecords("chapter.md")).toMatchObject([
        { wId: 1, turnId, status: "reversed" },
        { wId: 2, turnId, status: "active", createdSeq: 3 },
      ]);
    }

    const hot = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(hot);
    const hotUndo = await hot.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(hotUndo)).toContain("status: reversed");

    const cold = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(cold);
    const coldUndo = await cold.core.undoTurn("chapter.md", THREAD_ID);
    expect(outcomeText(coldUndo)).toContain("status: reversed");

    expect(blockTexts(hot.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
    expect(blockTexts(cold.liveDoc("chapter.md"))).toEqual(blockTexts(hot.liveDoc("chapter.md")));
    expect(cold.journal.mutationRecords("chapter.md")).toMatchObject([
      { wId: 1, status: "reversed" },
      { wId: 2, status: "reversed" },
    ]);
  });

  it("cold redo replays the most recent reversed subset inside a reused turn id", async () => {
    const turnId = "turn-cold-redo-subset";

    async function setup(ctx: ReturnType<typeof harness>) {
      const turnContext = { ...context, turnId };
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
        turnContext,
      );
      await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        turnContext,
      );
      await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
      const rows = ctx.journal.mutationRecords("chapter.md");
      expect(rows).toMatchObject([
        { wId: 1, turnId, status: "reversed", undoUpdateSeq: expect.any(Number) },
        { wId: 2, turnId, status: "reversed", undoUpdateSeq: expect.any(Number) },
      ]);
      expect(rows[1]?.undoUpdateSeq).not.toBe(rows[0]?.undoUpdateSeq);
    }

    const hot = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(hot);
    const hotRedo = await hot.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(hotRedo)).toContain("status: reversed");

    const cold = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(cold);
    const coldRedo = await cold.core.redoTurn("chapter.md", THREAD_ID);
    expect(outcomeText(coldRedo)).toContain("status: reversed");

    expect(blockTexts(hot.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
    expect(blockTexts(cold.liveDoc("chapter.md"))).toEqual(blockTexts(hot.liveDoc("chapter.md")));
    expect(cold.journal.mutationRecords("chapter.md")).toMatchObject([
      { wId: 1, status: "reversed" },
      { wId: 2, status: "active" },
    ]);
    expect(cold.journal.mutationRecords("chapter.md")[1]?.undoUpdateSeq).toBeUndefined();
  });

  it("reports undo availability only while active mutation updates are retained", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-availability" },
    );

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-availability",
    });

    await ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: false,
    });
    expect(
      outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_undo");
  });

  it("reports redo availability through the existing linear redo eligibility rule", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-redo-availability" },
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoTurnId: "turn-redo-availability",
    });

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "New forward edit." },
      { ...context, turnId: "turn-after-undo" },
    );

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-after-undo",
    });
    expect(
      outcomeText(await ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_redo");
  });

  it("reports redo unavailable when partial compaction drops the reversed turn start", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const turnContext = { ...context, turnId: "turn-redo-compacted-prefix" };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
      turnContext,
    );
    const stateAfterFirstForwardWrite = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      turnContext,
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoTurnId: "turn-redo-compacted-prefix",
    });

    await ctx.journal.checkpoint("chapter.md", stateAfterFirstForwardWrite, 1);

    expect((await ctx.journal.read("chapter.md")).updates.map((update) => update.seq)).toEqual([
      2, 3,
    ]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: false,
    });
    expect(
      outcomeText(await ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_redo");
  });

  it("formats undo and redo responses without internal UUIDs and with fresh undo hashes", async () => {
    const ctx = harness({
      "chapter.md":
        "Beta waits in the clearing, sword drawn.\n\nThe wind carries the scent of rain.",
    });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const originalHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    await ctx.core.write(
      { command: "replace", file: `chapter.md#${originalHash}`, content: "" },
      { ...context, turnId: "turn-response-format" },
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const undoLines = outcomeText(undo).split("\n");

    expect(undoLines.slice(0, 4)).toEqual(["status: reversed", "", "undo: 1 edit(s)", ""]);
    expect(undoLines[4]).toMatch(/^[0-9a-f]{4}\|Beta waits in the clearing, sword drawn\.$/);
    expect(undoLines[4]?.split("|")[0]).not.toBe(originalHash);
    expectNoInternalIds(outcomeText(undo));

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo).split("\n").slice(0, 4)).toEqual([
      "status: reversed",
      "",
      "redo: 1 edit(s)",
      "",
    ]);
    expectNoInternalIds(outcomeText(redo));
  });

  it("formats partial undo and redo responses without internal IDs", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-partial-format" },
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context);

    expect(outcomeText(undo)).toContain("status: partial");
    expect(outcomeText(undo)).toContain("undo: 1 edit(s)");
    expectNoInternalIds(outcomeText(undo));

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md", last: 2 }, context);

    expect(outcomeText(redo)).toContain("status: partial");
    expect(outcomeText(redo)).toContain("redo: 1 edit(s)");
    expectNoInternalIds(outcomeText(redo));
  });

  it("filters expired redo records without leaking internal IDs", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { retention: { reversalWindowMs: -1 } });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-expired-format" },
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toBe("status: nothing_to_redo");
    expectNoInternalIds(outcomeText(redo));
  });

  it("invalidates a thread runtime and rebuilds the next view from recovered live state", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-before-invalidate" },
    );
    expect(ctx.undoRegistry.getState("chapter.md", THREAD_ID)).not.toBeNull();

    const live = ctx.liveDoc("chapter.md");
    const beforeVector = Y.encodeStateVector(live);
    humanText(live, 0, { from: 0, to: 0 }, "Human ");
    await ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeVector), {
      origin: "human:user-a",
      seq: 0,
    });

    ctx.core.invalidateThread("chapter.md", THREAD_ID);

    expect(ctx.undoRegistry.getState("chapter.md", THREAD_ID)).toBeNull();
    const view = await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    expect(outcomeText(view)).toContain("|Human Alpha blade.");
  });

  it("drops staged response buffers when invalidating a thread", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      {
        ...context,
        turnId: "turn-stale-buffer",
        responseId: "response-stale-buffer",
      },
    );

    ctx.core.invalidateThread("chapter.md", THREAD_ID);
    const commit = await ctx.core.commitResponse("response-stale-buffer");

    expect(commit).toMatchObject({
      documentCount: 0,
      updateCount: 0,
      stagedCreates: { committed: [], discarded: [] },
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const view = await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    expect(outcomeText(view)).toContain("|Alpha.");
    expect(outcomeText(view)).not.toContain("Beta.");
  });

  it("exposes user turn undo and redo seams by document and thread", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-user-seam" },
    );

    const undo = await ctx.core.undoTurn("chapter.md", THREAD_ID);

    expect(outcomeText(undo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
    expect(ctx.undoRegistry.getState("chapter.md", THREAD_ID)).toBeNull();

    const redo = await ctx.core.redoTurn("chapter.md", THREAD_ID);

    expect(outcomeText(redo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
    expect(ctx.undoRegistry.getState("chapter.md", THREAD_ID)).toBeNull();
  });

  it("surfaces committed w-id attachment drift in dev and test", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    ctx.undoRegistry.attachNextWId = () => false;

    const result = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-attach-drift" },
    );

    expectOutcome(result, "internal_error", true);
    expect(outcomeText(result)).toContain("Failed to attach committed w-id 1");
    expect(outcomeText(result)).toContain("turn-attach-drift");
  });

  it("rolls back staged response writes and restores the runtime doc from live", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-response-rollback",
      responseId: "response-rollback",
    };

    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    expect(outcomeText(staged)).toContain("Beta.");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);

    await ctx.core.rollbackResponse("response-rollback");

    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const view = await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    expect(outcomeText(view)).toContain("Alpha.");
    expect(outcomeText(view)).not.toContain("Beta.");
  });

  it("keeps response commit all-or-nothing when the journal batch append fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-response-journal-fail",
      responseId: "response-journal-fail",
    };
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    ctx.journal.failNextAppendBatchWith(new Error("journal unavailable"));

    await expect(ctx.core.commitResponse("response-journal-fail")).rejects.toThrow(
      /before the journal batch was committed/,
    );

    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const viewAfterFailure = await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    expect(outcomeText(viewAfterFailure)).toContain("Alpha.");
    expect(outcomeText(viewAfterFailure)).not.toContain("Beta.");

    const retry = await ctx.core.commitResponse("response-journal-fail");

    expect(retry).toMatchObject({ documentCount: 1, updateCount: 1 });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);

    const followup = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Recovered.", find: "Beta." },
      context,
    );
    expectOutcome(followup, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Recovered."]);
  });

  it("keeps a post-journal response as the next undo target after live recovery", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, turnId: "turn-prior-history" },
    );
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "First", find: "Alpha" },
      { ...context, turnId: "turn-redo-source" },
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);

    const responseContext = {
      ...context,
      turnId: "turn-response-live-fail",
      responseId: "response-live-fail",
    };
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Gamma." },
      responseContext,
    );
    ctx.coordinator.failNextWith(new Error("live merge unavailable"));

    await expect(ctx.core.commitResponse("response-live-fail")).resolves.toMatchObject({
      responseId: "response-live-fail",
      documentCount: 1,
      updateCount: 1,
    });

    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(4);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma."]);

    const redoBeforeUndo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoBeforeUndo)).toBe("status: nothing_to_redo");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma."]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(undo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma."]);
  });

  it("recovers all documents when a multi-document response fails during the second live merge", async () => {
    const ctx = harness({ "alpha.md": "Alpha.", "beta.md": "One." });
    await ctx.core.write({ command: "view", file: "alpha.md" }, context);
    await ctx.core.write({ command: "view", file: "beta.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-multi-doc-response",
      responseId: "response-multi-doc-live-fail",
    };

    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "Beta." },
      responseContext,
    );
    await ctx.core.write({ command: "insert", file: "beta.md", content: "Two." }, responseContext);
    expect((await ctx.journal.read("alpha.md")).updates).toHaveLength(0);
    expect((await ctx.journal.read("beta.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["One."]);

    ctx.coordinator.failNextForDoc("beta.md", new Error("second live merge unavailable"));

    await expect(ctx.core.commitResponse("response-multi-doc-live-fail")).resolves.toMatchObject({
      responseId: "response-multi-doc-live-fail",
      documentCount: 2,
      updateCount: 2,
      documents: [
        { documentId: "alpha.md", updateCount: 1 },
        { documentId: "beta.md", updateCount: 1 },
      ],
    });

    expect(ctx.journal.appendBatchCalls).toBe(1);
    expect((await ctx.journal.read("alpha.md")).updates).toHaveLength(1);
    expect((await ctx.journal.read("beta.md")).updates).toHaveLength(1);
    expect(ctx.journal.mutationRecords("alpha.md").map((record) => record.wId)).toEqual([1]);
    expect(ctx.journal.mutationRecords("beta.md").map((record) => record.wId)).toEqual([1]);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha.", "Beta."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["One.", "Two."]);
    expect(ctx.undoRegistry.getState("alpha.md", THREAD_ID)).toBeNull();
    expect(ctx.undoRegistry.getState("beta.md", THREAD_ID)).toBeNull();
    expect(await ctx.core.getAvailability("alpha.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-multi-doc-response",
    });
    expect(await ctx.core.getAvailability("beta.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-multi-doc-response",
    });

    const freshContext = { ...context, sessionId: "fresh-session" };
    expect(
      renderedBlockBodies(
        await ctx.core.write({ command: "view", file: "alpha.md" }, freshContext),
      ),
    ).toEqual(["Alpha.", "Beta."]);
    expect(
      renderedBlockBodies(await ctx.core.write({ command: "view", file: "beta.md" }, freshContext)),
    ).toEqual(["One.", "Two."]);
    await expect(ctx.core.commitResponse("response-multi-doc-live-fail")).resolves.toMatchObject({
      documentCount: 0,
      updateCount: 0,
    });
  });

  it("invalidates staged runtime and drops the buffer when rollback restore fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-response-rollback-fail",
      responseId: "response-rollback-fail",
    };
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    ctx.coordinator.failNextWith(new Error("restore unavailable"));

    await expect(ctx.core.rollbackResponse("response-rollback-fail")).rejects.toThrow(
      "restore unavailable",
    );

    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const view = await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    expect(outcomeText(view)).toContain("Alpha.");
    expect(outcomeText(view)).not.toContain("Beta.");
    await expect(ctx.core.commitResponse("response-rollback-fail")).resolves.toMatchObject({
      updateCount: 0,
    });
  });

  it("appends unanchored inserts and handles explicit start and end anchors", async () => {
    const noAnchorCtx = harness({ "chapter.md": "One\n\nTwo\n\nThree" });
    await noAnchorCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const noAnchor = await noAnchorCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Four\n\nFive" },
      context,
    );

    expect(outcomeText(noAnchor)).toContain("status: success");
    const expectedEndOrder = ["One", "Two", "Three", "Four", "Five"];
    expect(blockTexts(noAnchorCtx.liveDoc("chapter.md"))).toEqual(expectedEndOrder);
    expect(
      renderedBlockBodies(
        await noAnchorCtx.core.write({ command: "view", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedEndOrder);

    const beforeFirstCtx = harness({ "chapter.md": "Alpha\n\nBeta" });
    await beforeFirstCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const firstHash = hashAt(beforeFirstCtx.liveDoc("chapter.md"), 0);

    const beforeFirst = await beforeFirstCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Start A\n\nStart B", before: firstHash },
      context,
    );

    expect(outcomeText(beforeFirst)).toContain("status: success");
    const expectedStartOrder = ["Start A", "Start B", "Alpha", "Beta"];
    expect(blockTexts(beforeFirstCtx.liveDoc("chapter.md"))).toEqual(expectedStartOrder);
    expect(
      renderedBlockBodies(
        await beforeFirstCtx.core.write({ command: "view", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedStartOrder);

    const afterLastCtx = harness({ "chapter.md": "One\n\nTwo\n\nThree" });
    await afterLastCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const lastHash = hashAt(afterLastCtx.liveDoc("chapter.md"), 2);

    const afterLast = await afterLastCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Four\n\nFive", after: lastHash },
      context,
    );

    expect(outcomeText(afterLast)).toContain("status: success");
    expect(blockTexts(afterLastCtx.liveDoc("chapter.md"))).toEqual(expectedEndOrder);
    expect(
      renderedBlockBodies(
        await afterLastCtx.core.write({ command: "view", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedEndOrder);

    const emptyCtx = harness();
    emptyCtx.coordinator.createEmpty("empty.md");
    await emptyCtx.core.write({ command: "view", file: "empty.md" }, context);

    const emptyInsert = await emptyCtx.core.write(
      { command: "insert", file: "empty.md", content: "Only block" },
      context,
    );

    expect(outcomeText(emptyInsert)).toContain("status: success");
    expect(blockTexts(emptyCtx.liveDoc("empty.md"))).toEqual(["Only block"]);
    expect(
      renderedBlockBodies(
        await emptyCtx.core.write({ command: "view", file: "empty.md" }, context),
      ),
    ).toEqual(["Only block"]);
  });

  it("replaces text, formatting, and deletes through replace(content='')", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword.\n\nDelete me." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const text = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(outcomeText(text)).toContain("status: success");
    expect(outcomeText(text)).toContain("|Alpha blade.");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha blade.");

    const formatted = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "**blade**", find: "blade" },
      context,
    );
    expect(outcomeText(formatted)).toContain("status: success");
    expect(outcomeText(formatted)).toContain("|Alpha **blade**.");
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toContain("Alpha **blade**.");

    const deleteHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const deletion = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", in: deleteHash },
      context,
    );

    expect(outcomeText(deletion)).toContain("status: success");
    expect(outcomeText(deletion)).toContain(`deleted: ${deleteHash}`);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("replaces and deletes find matches that span block boundaries", async () => {
    const replaceCtx = harness({ "chapter.md": "Alpha starts\n\nends Omega" });
    await replaceCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const replaced = await replaceCtx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "middle",
        find: "starts\n\nends",
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(replaceCtx.liveDoc("chapter.md"))).toEqual(["Alpha middle Omega"]);

    const deleteCtx = harness({ "chapter.md": "Before X\n\nMiddle\n\nY After" });
    await deleteCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const deleted = await deleteCtx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "",
        find: "X\n\nMiddle\n\nY",
      },
      context,
    );

    expect(outcomeText(deleted)).toContain("status: success");
    expect(blockTexts(deleteCtx.liveDoc("chapter.md"))).toEqual(["Before  After"]);

    const insertCtx = harness({ "chapter.md": "Alpha starts\n\nends Omega" });
    await insertCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const inserted = await insertCtx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "starts\n\nends",
      },
      context,
    );

    expect(outcomeText(inserted)).toContain("status: success");
    expect(blockTexts(insertCtx.liveDoc("chapter.md"))).toEqual(["Alpha starts", "ends! Omega"]);
  });

  it("views around windows with radius three and clamps at document edges", async () => {
    const ctx = harness({ "chapter.md": numberedBlocks(9) });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const middleHash = hashAt(ctx.liveDoc("chapter.md"), 4);
    const nearStartHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const nearEndHash = hashAt(ctx.liveDoc("chapter.md"), 7);

    const middle = await ctx.core.write(
      { command: "view", file: "chapter.md", around: middleHash },
      context,
    );
    const middleWithHashPrefix = await ctx.core.write(
      { command: "view", file: "chapter.md", around: `#${middleHash}` },
      context,
    );
    const nearStart = await ctx.core.write(
      { command: "view", file: "chapter.md", around: nearStartHash },
      context,
    );
    const nearEnd = await ctx.core.write(
      { command: "view", file: "chapter.md", around: nearEndHash },
      context,
    );

    expect(renderedBlockBodies(middle)).toEqual([
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
    ]);
    expect(outcomeText(middleWithHashPrefix)).toBe(outcomeText(middle));
    expect(renderedBlockBodies(nearStart)).toEqual([
      "Block 1",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
    ]);
    expect(renderedBlockBodies(nearEnd)).toEqual([
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9",
    ]);
  });

  it("scopes find-based replace and insert to around windows", async () => {
    const replaceCtx = harness({ "chapter.md": aroundNeedleBlocks() });
    await replaceCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const replaceAround = hashAt(replaceCtx.liveDoc("chapter.md"), 4);

    const replaced = await replaceCtx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "changed",
        find: "needle",
        around: replaceAround,
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(replaceCtx.liveDoc("chapter.md"))).toEqual([
      "Block 1 needle",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5 changed",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9 needle",
    ]);

    const insertCtx = harness({ "chapter.md": aroundNeedleBlocks() });
    await insertCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const insertAround = hashAt(insertCtx.liveDoc("chapter.md"), 4);

    const inserted = await insertCtx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "needle",
        around: insertAround,
      },
      context,
    );

    expect(outcomeText(inserted)).toContain("status: success");
    expect(blockTexts(insertCtx.liveDoc("chapter.md"))).toEqual([
      "Block 1 needle",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5 needle!",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9 needle",
    ]);
  });

  it("keeps find-based replacement reachable through file fragments", async () => {
    const ctx = harness({ "chapter.md": "# Arena\n\nsword here\n\n# After\n\nsword there" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const result = await ctx.core.write(
      { command: "replace", file: `chapter.md#${headingHash}`, content: "blade", find: "sword" },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expect(outcomeText(result)).toContain("|blade here");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Arena",
      "blade here",
      "After",
      "sword there",
    ]);
  });

  it("undoes and redoes this thread's writes", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(undo)).toContain("status: reversed");
    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("status: reversed");
    expectOutcome(redo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("rehydrates durable redo after restart and marks it redone", async () => {
    const turnId = "thread-a:chapter.md:turn-restart-redo";

    async function writeThenUndo(ctx: ReturnType<typeof harness>) {
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        { ...context, turnId },
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

      const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      expect(outcomeText(undo)).toContain("status: reversed");
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

      const [reversal] = await ctx.journal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      });
      expect(reversal).toMatchObject({ turnId, status: "reversed" });
      expect(reversal?.undoUpdateSeq).toBeGreaterThan(0);
    }

    const hot = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeThenUndo(hot);
    const coldCoordinator = new MemoryCoordinator({});
    coldCoordinator.docs.set("chapter.md", cloneDoc(hot.liveDoc("chapter.md")));
    const coldLifecycle = new MemoryDocumentLifecycle(coldCoordinator);
    const coldJournal = hot.journal.clone();

    const hotRedo = await hot.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(hotRedo)).toContain("status: reversed");
    const hotTexts = blockTexts(hot.liveDoc("chapter.md"));
    const hotBytes = documentBytes(hot.liveDoc("chapter.md"));

    const restarted = createAgentEditCore({
      journal: coldJournal,
      coordinator: coldCoordinator,
      lifecycle: coldLifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expect(
      outcomeText(await restarted.write({ command: "view", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");

    const coldRedo = await restarted.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(coldRedo)).toContain("status: reversed");
    expect(blockTexts(coldCoordinator.require("chapter.md"))).toEqual(hotTexts);
    expect(documentBytes(coldCoordinator.require("chapter.md"))).toEqual(hotBytes);

    expect(
      await coldJournal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      }),
    ).toEqual([]);
    expect(
      await coldJournal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["redone"],
      }),
    ).toMatchObject([{ turnId, status: "redone" }]);

    const secondRestart = createAgentEditCore({
      journal: coldJournal,
      coordinator: coldCoordinator,
      lifecycle: coldLifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    await secondRestart.write({ command: "view", file: "chapter.md" }, context);

    const doubleRedo = await secondRestart.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(doubleRedo)).toBe("status: nothing_to_redo");
    expect(blockTexts(coldCoordinator.require("chapter.md"))).toEqual(hotTexts);
    expect(documentBytes(coldCoordinator.require("chapter.md"))).toEqual(hotBytes);
  });

  it("consumes durable redo once across concurrent restarted sessions", async () => {
    const turnId = "thread-a:chapter.md:turn-concurrent-redo";
    const initial = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await initial.core.write({ command: "view", file: "chapter.md" }, context);
    await initial.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId },
    );
    expect(
      outcomeText(await initial.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("status: reversed");
    expect(blockTexts(initial.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

    const coreA = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coreB = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });

    expect(
      outcomeText(await coreA.write({ command: "view", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");
    expect(
      outcomeText(await coreB.write({ command: "view", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");

    const redoA = await coreA.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoA)).toContain("status: reversed");
    const redoB = await coreB.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoB)).toBe("status: nothing_to_redo");

    expect(blockTexts(initial.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
    expect(
      await initial.journal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["redone"],
      }),
    ).toMatchObject([{ turnId, status: "redone" }]);
    expect(
      await initial.journal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      }),
    ).toEqual([]);
  });

  it("re-syncs undo and redo before marking the snapshot synced", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(undo)).toContain("status: reconciled");
    expectNoInternalIds(outcomeText(undo));
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha sword."]);

    const followup = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Writer", find: "Human" },
      context,
    );
    expect(outcomeText(followup)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Writer Alpha sword."]);

    const redoCtx = harness({ "chapter.md": "Alpha sword." });
    await redoCtx.core.write({ command: "view", file: "chapter.md" }, context);
    await redoCtx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    await redoCtx.core.write({ command: "undo", file: "chapter.md" }, context);
    humanText(redoCtx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");

    const redo = await redoCtx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("status: reconciled");
    expectNoInternalIds(outcomeText(redo));
    expect(blockTexts(redoCtx.liveDoc("chapter.md"))).toEqual(["Human Alpha blade."]);

    const redoFollowup = await redoCtx.core.write(
      { command: "replace", file: "chapter.md", content: "Writer", find: "Human" },
      context,
    );
    expect(outcomeText(redoFollowup)).toContain("status: success");
    expect(blockTexts(redoCtx.liveDoc("chapter.md"))).toEqual(["Writer Alpha blade."]);
  });

  it("undoes every separate write call in one turn on hot and cold paths", async () => {
    async function run(ctx: ReturnType<typeof harness>) {
      const turnContext = { ...context, turnId: "turn-with-two-writes" };
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);

      await ctx.core.write(
        { command: "insert", file: "chapter.md", content: "Inserted.", after: alphaHash },
        turnContext,
      );
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        turnContext,
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
        "Alpha blade.",
        "Inserted.",
        "Omega.",
      ]);

      const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      const undoText = outcomeText(undo);

      expect(undoText).toContain("status: reversed");
      expect(undoText).toContain("undo: 1 edit(s)");
      expect(undoText).not.toContain("turn-with-two-writes");
      return blockTexts(ctx.liveDoc("chapter.md"));
    }

    const hot = await run(harness({ "chapter.md": "Alpha sword.\n\nOmega." }));
    const cold = await run(
      harness(
        { "chapter.md": "Alpha sword.\n\nOmega." },
        { undoRegistry: createUndoManagerRegistry({ undoDepthCap: 0 }) },
      ),
    );

    expect(hot).toEqual(["Alpha sword.", "Omega."]);
    expect(cold).toEqual(hot);
  });

  it("returns LLM-readable not_found, ambiguous_match, and invalid_write errors", async () => {
    const ctx = harness({ "chapter.md": "sword one\n\nsword two" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const missing = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "x", after: "deadbeef" },
      context,
    );
    expect(outcomeText(missing)).toContain("status: not_found");
    expectOutcome(missing, "not_found", true);
    expect(outcomeText(missing)).toContain('write(command="view", file="chapter.md")');

    const ambiguous = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(outcomeText(ambiguous)).toContain("status: ambiguous_match");
    expectOutcome(ambiguous, "ambiguous_match", true);
    expect(outcomeText(ambiguous)).toContain("Found 2 matches");

    const invalid = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "" },
      context,
    );
    expect(outcomeText(invalid)).toContain("status: invalid_write");
    expectOutcome(invalid, "invalid_write", true);
    expect(outcomeText(invalid)).toContain("insert requires non-empty content");
  });

  it("returns invalid_write for invalid around scope combinations", async () => {
    const ctx = harness({ "chapter.md": aroundNeedleBlocks() });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const inHash = hashAt(ctx.liveDoc("chapter.md"), 4);
    const aroundHash = hashAt(ctx.liveDoc("chapter.md"), 5);

    const bothScopes = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "changed",
        find: "needle",
        in: inHash,
        around: aroundHash,
      },
      context,
    );
    expect(outcomeText(bothScopes)).toContain("status: invalid_write");
    expect(outcomeText(bothScopes)).toContain(
      "`in` and `around` are mutually exclusive scope parameters",
    );

    const aroundWithoutFind = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "changed", around: aroundHash },
      context,
    );
    expect(outcomeText(aroundWithoutFind)).toContain("status: invalid_write");
    expect(outcomeText(aroundWithoutFind)).toContain(
      "`around` only scopes find-based replace commands",
    );
  });

  it("maps typed missing documents differently from transient coordinator failures", async () => {
    const missingCtx = harness();

    const missing = await missingCtx.core.write({ command: "view", file: "missing.md" }, context);

    expect(outcomeText(missing)).toContain("status: document_not_found");
    expectOutcome(missing, "document_not_found", true);

    const failingCtx = harness({ "chapter.md": "Alpha." });
    failingCtx.coordinator.failWith(new Error("database unavailable"));

    const transient = await failingCtx.core.write({ command: "view", file: "chapter.md" }, context);

    expect(outcomeText(transient)).toContain("status: internal_error");
    expectOutcome(transient, "internal_error", true);
    expect(outcomeText(transient)).toContain("database unavailable");
  });
});

function harness(
  initialDocs: Record<string, string> = {},
  options: {
    undoRegistry?: ReturnType<typeof createUndoManagerRegistry>;
    lifecycle?: boolean;
    undoClientId?: number;
    retention?: {
      reversalWindowMs?: number;
    };
  } = {},
) {
  const coordinator = new MemoryCoordinator(initialDocs);
  const lifecycle = new MemoryDocumentLifecycle(coordinator);
  const journal = new MemoryJournal();
  const undoRegistry = options.undoRegistry ?? createUndoManagerRegistry();
  coordinator.useJournal(journal);
  for (const [docId, doc] of coordinator.docs)
    journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
  const core = createAgentEditCore({
    journal,
    coordinator,
    ...(options.lifecycle === false ? {} : { lifecycle }),
    codec,
    model,
    undoRegistry,
    undoClientId: options.undoClientId,
    ...(options.retention ? { retention: options.retention } : {}),
  });
  return {
    core,
    coordinator,
    lifecycle,
    journal,
    undoRegistry,
    liveDoc: (docId: string) => coordinator.require(docId),
  };
}

class MemoryDocumentLifecycle implements DocumentLifecycle {
  constructor(private readonly coordinator: MemoryCoordinator) {}

  async ensureDocument(docId: string): Promise<void> {
    this.coordinator.ensureEmpty(docId);
  }
}

class MemoryCoordinator implements DocumentCoordinator {
  readonly docs = new Map<string, Y.Doc>();
  private journal?: UpdateJournal;
  private failure: unknown;
  private nextFailure: unknown;
  private readonly nextFailureByDoc = new Map<string, unknown>();

  constructor(initialDocs: Record<string, string>) {
    for (const [docId, markdown] of Object.entries(initialDocs)) {
      this.docs.set(docId, createDoc(markdown, 100 + this.docs.size));
    }
  }

  createEmpty(docId: string): Y.Doc {
    return this.ensureEmpty(docId);
  }

  ensureEmpty(docId: string): Y.Doc {
    const existing = this.docs.get(docId);
    if (existing) return existing;
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 100 + this.docs.size;
    this.docs.set(docId, doc);
    return doc;
  }

  require(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new DocumentNotFoundError(docId);
    return doc;
  }

  failWith(cause: unknown): void {
    this.failure = cause;
  }

  failNextWith(cause: unknown): void {
    this.nextFailure = cause;
  }

  failNextForDoc(docId: string, cause: unknown): void {
    this.nextFailureByDoc.set(docId, cause);
  }

  useJournal(journal: UpdateJournal): void {
    this.journal = journal;
  }

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    if (this.nextFailureByDoc.has(docId)) {
      const failure = this.nextFailureByDoc.get(docId);
      this.nextFailureByDoc.delete(docId);
      throw failure;
    }
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      throw failure;
    }
    if (this.failure) throw this.failure;
    return fn(this.require(docId));
  }

  async recover(docId: string): Promise<void> {
    if (!this.journal) return;
    const snapshot = await this.journal.read(docId);
    if (!snapshot.checkpoint && snapshot.updates.length === 0) return;
    const doc = this.ensureEmpty(docId);
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint, { type: "system" });
    for (const entry of snapshot.updates) {
      Y.applyUpdate(doc, entry.update, { type: "system" });
    }
  }
}

class MemoryJournal extends InMemoryAgentEditJournal {
  appendBatchCalls = 0;
  appendBatchEntryOrders: string[][] = [];
  private nextAppendBatchFailure: unknown;

  override async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    this.appendBatchCalls += 1;
    this.appendBatchEntryOrders.push(
      entries.map((entry) => `${entry.docId}:${entry.mutation?.turnId ?? ""}`),
    );
    if (this.nextAppendBatchFailure) {
      const failure = this.nextAppendBatchFailure;
      this.nextAppendBatchFailure = undefined;
      throw failure;
    }
    return super.appendBatch(entries);
  }

  failNextAppendBatchWith(cause: unknown): void {
    this.nextAppendBatchFailure = cause;
  }
}

function createDoc(markdown: string, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const root = schema.node("doc", null, codec.parse(markdown).blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  doc.clientID = clientID;
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function hashAt(doc: Y.Doc, index: number): string {
  const block = model.getBlocks(doc)[index];
  if (!block) throw new Error(`No block at ${index}`);
  return model.getBlockId(block);
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

function outcomeText(output: string | WriteOutcome): string {
  return typeof output === "string" ? output : output.text;
}

function expectOutcome(outcome: WriteOutcome, status: WriteStatus, isError = false): void {
  expect(outcome.status).toBe(status);
  expect(outcome.isError).toBe(isError);
}

function expectNoInternalIds(text: string): void {
  expect(text).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
  expect(text).not.toContain("turn-");
}

function renderedBlockBodies(output: string | WriteOutcome): string[] {
  const rendered = outcomeText(output);
  if (!rendered) return [];
  return rendered.split("\n").map((line) => line.replace(/^[0-9a-f]{4,}\|/, ""));
}

function numberedBlocks(count: number): string {
  return Array.from({ length: count }, (_, index) => `Block ${index + 1}`).join("\n\n");
}

function aroundNeedleBlocks(): string {
  return [
    "Block 1 needle",
    "Block 2",
    "Block 3",
    "Block 4",
    "Block 5 needle",
    "Block 6",
    "Block 7",
    "Block 8",
    "Block 9 needle",
  ].join("\n\n");
}

function humanText(
  doc: Y.Doc,
  blockIndex: number,
  span: { from: number; to: number },
  text: string,
): void {
  const block = model.getBlocks(doc)[blockIndex];
  if (!block) throw new Error(`No block at ${blockIndex}`);
  doc.transact(
    () => {
      model.applyTextEdit(doc, block, span, text);
    },
    { type: "human" },
  );
}

function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.getBlocks(doc).map((block) => model.toProsemirrorBlock(doc, block)));
}

function documentBytes(doc: Y.Doc): number[] {
  return Array.from(Y.encodeStateAsUpdate(doc));
}
