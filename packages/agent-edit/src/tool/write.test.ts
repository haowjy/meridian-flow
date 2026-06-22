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
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalRecord,
  ReversalStatus,
  UpdateMeta,
} from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { createUndoManagerRegistry } from "../undo/manager-registry.js";
import type { WriteContext, WriteOutcome, WriteStatus } from "./types.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);
const context: WriteContext = { sessionId: "session-a", threadId: "thread-a" };
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
    expect(snapshot.checkpoint).toBeNull();
    expect(snapshot.updates).toHaveLength(1);
    const replayed = new Y.Doc({ gc: false });
    for (const update of snapshot.updates) Y.applyUpdate(replayed, update.update);
    expect(blockTexts(replayed)).toEqual(["Draft", "Opening line."]);
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
    expect(outcomeText(text)).toBe("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha blade.");

    const formatted = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "**blade**", find: "blade" },
      context,
    );
    expect(outcomeText(formatted)).toBe("status: success");
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

    expect(outcomeText(result)).toBe("status: success");
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

      expect(outcomeText(undo)).toContain("status: reversed");
      expect(outcomeText(undo)).toContain("undo: turn-with-two-writes");
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
  } = {},
) {
  const coordinator = new MemoryCoordinator(initialDocs);
  const lifecycle = new MemoryDocumentLifecycle(coordinator);
  const journal = new MemoryJournal();
  for (const [docId, doc] of coordinator.docs)
    journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
  const core = createAgentEditCore({
    journal,
    coordinator,
    ...(options.lifecycle === false ? {} : { lifecycle }),
    codec,
    model,
    undoRegistry: options.undoRegistry,
    undoClientId: options.undoClientId,
  });
  return {
    core,
    coordinator,
    lifecycle,
    journal,
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
  private failure: unknown;

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

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    return fn(this.require(docId));
  }

  async recover(_docId: string): Promise<void> {}
}

class MemoryJournal implements UpdateJournal {
  private readonly data = new Map<
    string,
    {
      checkpoint: Uint8Array | null;
      checkpointUpToSeq: number;
      nextSeq: number;
      updates: PersistedUpdate[];
      reversals: ReversalRecord[];
    }
  >();

  setCheckpoint(docId: string, checkpoint: Uint8Array): void {
    this.entry(docId).checkpoint = checkpoint;
  }

  async append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
    return this.appendSync(docId, update, meta);
  }

  async read(
    docId: string,
    opts: { since?: number; until?: number } = {},
  ): Promise<JournalSnapshot> {
    const entry = this.entry(docId);
    return {
      checkpoint: entry.checkpoint,
      updates: entry.updates.filter(
        (update) =>
          update.seq > entry.checkpointUpToSeq &&
          (opts.since === undefined || update.seq >= opts.since) &&
          (opts.until === undefined || update.seq <= opts.until),
      ),
    };
  }

  async checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void> {
    const entry = this.entry(docId);
    entry.checkpoint = state;
    entry.checkpointUpToSeq = upToSeq;
  }

  async compact(docId: string, _before: Date): Promise<CompactionResult> {
    const entry = this.entry(docId);
    const doc = new Y.Doc({ gc: false });
    if (entry.checkpoint) Y.applyUpdate(doc, entry.checkpoint);
    const retained = entry.updates.filter((update) => update.seq > entry.checkpointUpToSeq);
    for (const update of retained) Y.applyUpdate(doc, update.update);
    const updatesFolded = retained.length;
    entry.checkpoint = Y.encodeStateAsUpdate(doc);
    entry.checkpointUpToSeq = retained.at(-1)?.seq ?? entry.checkpointUpToSeq;
    entry.updates = entry.updates.filter((update) => update.seq > entry.checkpointUpToSeq);
    return { updatesFolded, reversalsExpired: 0 };
  }

  async persistReversal(
    docId: string,
    undoUpdate: Uint8Array,
    record: ReversalRecord,
  ): Promise<void> {
    const seq = this.appendSync(docId, undoUpdate, { origin: "system", seq: 0 });
    record.undoUpdateSeq = seq;
    this.entry(docId).reversals.push({ ...record });
  }

  async persistRedo(
    docId: string,
    redoUpdate: Uint8Array,
    ref: { threadId: string; turnId: string },
    meta: UpdateMeta,
  ): Promise<{ consumed: boolean; seq?: number }> {
    const entry = this.entry(docId);
    const index = entry.reversals.findIndex(
      (record) =>
        record.threadId === ref.threadId &&
        record.turnId === ref.turnId &&
        record.status === "reversed",
    );
    if (index === -1) return { consumed: false };
    const seq = this.appendSync(docId, redoUpdate, meta);
    entry.reversals[index] = { ...entry.reversals[index], status: "redone" };
    return { consumed: true, seq };
  }

  clone(): MemoryJournal {
    const copy = new MemoryJournal();
    for (const [docId, entry] of this.data) {
      copy.data.set(docId, {
        checkpoint: entry.checkpoint ? new Uint8Array(entry.checkpoint) : null,
        checkpointUpToSeq: entry.checkpointUpToSeq,
        nextSeq: entry.nextSeq,
        updates: entry.updates.map((update) => ({
          seq: update.seq,
          update: new Uint8Array(update.update),
          meta: { ...update.meta },
        })),
        reversals: entry.reversals.map((record) => ({ ...record })),
      });
    }
    return copy;
  }

  async readReversals(
    docId: string,
    opts: { threadId?: string; status?: ReversalStatus[] } = {},
  ): Promise<ReversalRecord[]> {
    return this.entry(docId)
      .reversals.filter(
        (record) =>
          (opts.threadId === undefined || record.threadId === opts.threadId) &&
          (opts.status === undefined || opts.status.includes(record.status)),
      )
      .map((record) => ({ ...record }));
  }

  private entry(docId: string): {
    checkpoint: Uint8Array | null;
    checkpointUpToSeq: number;
    nextSeq: number;
    updates: PersistedUpdate[];
    reversals: ReversalRecord[];
  } {
    let entry = this.data.get(docId);
    if (!entry) {
      entry = { checkpoint: null, checkpointUpToSeq: 0, nextSeq: 1, updates: [], reversals: [] };
      this.data.set(docId, entry);
    }
    return entry;
  }

  private appendSync(docId: string, update: Uint8Array, meta: UpdateMeta): number {
    const entry = this.entry(docId);
    const seq = entry.nextSeq++;
    if (meta.seq && meta.seq !== seq) throw new Error(`Expected seq ${seq}, got ${meta.seq}`);
    entry.updates.push({ seq, update, meta: { ...meta, seq } });
    return seq;
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
