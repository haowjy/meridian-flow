// End-to-end write(command=...) coverage with in-memory port fakes.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import { fragmentOf } from "../model/y-prosemirror.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import {
  blockTexts,
  expectOutcome,
  hashAt,
  outcomeText,
  renderedBlockBodies,
  serializeDoc,
} from "./test-support/assertions.js";
import { codec, context, harness, model, THREAD_ID } from "./test-support/write-tool-harness.js";
import { createWriteTool } from "./write.js";

const INTERNAL_DOCUMENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const MODEL_PATH = "work://chapter-2.md";

describe("write tool dispatch", () => {
  it("requires reversal store capabilities at construction time", () => {
    if (Date.now() < 0) {
      const oldJournalOnly = {} as UpdateJournal;
      createWriteTool({
        // @ts-expect-error write-level mutations require ReversalStore capabilities.
        journal: oldJournalOnly,
        coordinator: undefined as never,
        codec: undefined as never,
        model: undefined as never,
      });
    }

    expect(true).toBe(true);
  });

  it("sanitizes setup capability failures when a host bypasses the construction type", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    const oldJournalOnly = {
      append: ctx.journal.append.bind(ctx.journal),
      appendBatch: ctx.journal.appendBatch.bind(ctx.journal),
      read: ctx.journal.read.bind(ctx.journal),
      checkpoint: ctx.journal.checkpoint.bind(ctx.journal),
      compact: ctx.journal.compact.bind(ctx.journal),
    } as unknown as UpdateJournal & ReversalStore;
    const core = createAgentEditCore({
      journal: oldJournalOnly,
      coordinator: ctx.coordinator,
      lifecycle: ctx.lifecycle,
      codec,
      model,
    });

    await core.write({ command: "read", file: "chapter.md" }, context);
    const write = await core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );

    expectOutcome(write, "internal_error", true);
    expect(outcomeText(write)).toBe(
      "status: internal_error\n\nRetry — transient edit system failure.",
    );
    expect(outcomeText(write)).not.toMatch(/ReversalStore|reserveWriteOrdinal|is not a function/i);
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
      renderedBlockBodies(await ctx.core.write({ command: "read", file: "new.md" }, context)),
    ).toEqual(["# Draft", "Opening line."]);

    const snapshot = await ctx.journal.read("new.md");
    expect(snapshot.checkpoint).toBeNull();
    expect(snapshot.updates).toHaveLength(1);
    const replayed = new Y.Doc({ gc: false });
    for (const update of snapshot.updates) Y.applyUpdate(replayed, update.update);
    expect(blockTexts(replayed)).toEqual(["Draft", "Opening line."]);
  });

  it("rejects create for an existing non-empty file with overwrite guidance", async () => {
    const ctx = harness({ "chapter.md": "Already here." });

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Replacement." },
      context,
    );

    expect(outcomeText(result)).toContain("status: invalid_write");
    expectOutcome(result, "invalid_write", true);
    expect(outcomeText(result)).toContain("File already exists: chapter.md");
    expect(outcomeText(result)).toContain("overwrite=true");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Already here."]);
  });

  it("overwrites an existing document when create uses overwrite=true", async () => {
    const ctx = harness({ "chapter.md": "Old content.\n\nSecond paragraph." });

    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "# Fresh\n\nNew content.",
        overwrite: true,
      },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expectOutcome(result, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Fresh", "New content."]);
  });

  it("fully replaces canonical blocks on immediate stale-replica create overwrite", async () => {
    const ctx = harness({ "chapter.md": "Alpha canonical." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    appendLiveBlock(ctx.liveDoc("chapter.md"), "Beta canonical.");

    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "Replacement only.",
        overwrite: true,
      },
      context,
    );

    expectOutcome(result, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Replacement only."]);
  });

  it("fully replaces canonical blocks on staged stale-replica create overwrite", async () => {
    const ctx = harness({ "chapter.md": "Alpha canonical." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    appendLiveBlock(ctx.liveDoc("chapter.md"), "Beta canonical.");
    const responseContext = {
      ...context,
      turnId: "turn-staged-overwrite-stale",
      responseId: "response-staged-overwrite-stale",
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "Replacement only.",
        overwrite: true,
      },
      responseContext,
    );

    expectOutcome(result, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha canonical.", "Beta canonical."]);

    await ctx.core.commitResponse("response-staged-overwrite-stale");

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Replacement only."]);
  });

  it("rejects non-overwrite create against canonical content even when the replica is empty", async () => {
    const ctx = harness({ "chapter.md": "Canonical content." });

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Replacement." },
      context,
    );

    expectOutcome(result, "invalid_write", true);
    expect(outcomeText(result)).toContain("File already exists: chapter.md");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Canonical content."]);
  });

  it("allows non-overwrite create when canonical is empty despite phantom replica blocks", async () => {
    const ctx = harness({ "chapter.md": "Phantom replica content." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    clearLiveBlocks(ctx.liveDoc("chapter.md"));

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Fresh canonical content." },
      context,
    );

    expectOutcome(result, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Fresh canonical content."]);
  });

  it("creates a fresh staged overwrite for a brand-new document", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-overwrite-new",
      responseId: "response-staged-overwrite-new",
    };

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "Fresh content.", overwrite: true },
      responseContext,
    );

    expectOutcome(result, "success");
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);

    const commit = await ctx.core.commitResponse("response-staged-overwrite-new");

    expect(commit.stagedCreates).toEqual({ committed: ["new.md"], discarded: [] });
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Fresh content."]);
  });

  it("keeps internal document ids out of model-facing write text", async () => {
    const ctx = harness({ [INTERNAL_DOCUMENT_ID]: "# Already here." });

    const createExisting = await ctx.core.write(
      {
        command: "create",
        documentId: INTERNAL_DOCUMENT_ID,
        file: MODEL_PATH,
        content: "Replacement.",
      },
      context,
    );
    expect(outcomeText(createExisting)).toContain(`File already exists: ${MODEL_PATH}`);
    expect(outcomeText(createExisting)).not.toContain(INTERNAL_DOCUMENT_ID);

    const autoSynced = await ctx.core.write(
      {
        command: "replace",
        documentId: INTERNAL_DOCUMENT_ID,
        file: MODEL_PATH,
        content: "New",
        find: "Already",
      },
      context,
    );
    expect(outcomeText(autoSynced)).toContain("status: success");
    expect(outcomeText(autoSynced)).not.toContain(INTERNAL_DOCUMENT_ID);

    const read = await ctx.core.write(
      { command: "read", documentId: INTERNAL_DOCUMENT_ID, file: MODEL_PATH, format: "outline" },
      context,
    );
    expect(outcomeText(read)).toContain(`write(command="read", file="${MODEL_PATH}#`);
    expect(outcomeText(read)).not.toContain(INTERNAL_DOCUMENT_ID);

    const replace = await ctx.core.write(
      {
        command: "replace",
        documentId: INTERNAL_DOCUMENT_ID,
        file: MODEL_PATH,
        content: "Still",
        find: "New",
      },
      context,
    );
    expect(outcomeText(replace)).not.toContain(INTERNAL_DOCUMENT_ID);
    expect(blockTexts(ctx.liveDoc(INTERNAL_DOCUMENT_ID))).toEqual(["Still here."]);
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
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

  it("keeps fallback turn ids distinct across runtime eviction", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
      context,
    );
    const [firstMutation] = ctx.journal.mutationRecords("chapter.md");
    const firstTurnId = firstMutation?.turnId;
    if (!firstTurnId) throw new Error("expected first fallback turn id");
    expect(firstTurnId).toMatch(/^thread-a:chapter\.md:turn-/);

    ctx.core.invalidateThread("chapter.md", THREAD_ID);
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );

    const [, secondMutation] = ctx.journal.mutationRecords("chapter.md");
    const secondTurnId = secondMutation?.turnId;
    if (!secondTurnId) throw new Error("expected second fallback turn id");
    expect(secondTurnId).toMatch(/^thread-a:chapter\.md:turn-/);
    expect(secondTurnId).not.toBe(firstTurnId);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { turnId: firstTurnId, status: "active" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { turnId: secondTurnId, status: "active" },
    ]);

    expect(
      outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("status: reconciled");

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Beta sword."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { turnId: firstTurnId, status: "active" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { turnId: secondTurnId, status: "reversed" },
    ]);
  });

  it("appends unanchored inserts and handles explicit start and end anchors", async () => {
    const noAnchorCtx = harness({ "chapter.md": "One\n\nTwo\n\nThree" });
    await noAnchorCtx.core.write({ command: "read", file: "chapter.md" }, context);

    const noAnchor = await noAnchorCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Four\n\nFive" },
      context,
    );

    expect(outcomeText(noAnchor)).toContain("status: success");
    const expectedEndOrder = ["One", "Two", "Three", "Four", "Five"];
    expect(blockTexts(noAnchorCtx.liveDoc("chapter.md"))).toEqual(expectedEndOrder);
    expect(
      renderedBlockBodies(
        await noAnchorCtx.core.write({ command: "read", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedEndOrder);

    const beforeFirstCtx = harness({ "chapter.md": "Alpha\n\nBeta" });
    await beforeFirstCtx.core.write({ command: "read", file: "chapter.md" }, context);
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
        await beforeFirstCtx.core.write({ command: "read", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedStartOrder);

    const afterLastCtx = harness({ "chapter.md": "One\n\nTwo\n\nThree" });
    await afterLastCtx.core.write({ command: "read", file: "chapter.md" }, context);
    const lastHash = hashAt(afterLastCtx.liveDoc("chapter.md"), 2);

    const afterLast = await afterLastCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Four\n\nFive", after: lastHash },
      context,
    );

    expect(outcomeText(afterLast)).toContain("status: success");
    expect(blockTexts(afterLastCtx.liveDoc("chapter.md"))).toEqual(expectedEndOrder);
    expect(
      renderedBlockBodies(
        await afterLastCtx.core.write({ command: "read", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedEndOrder);

    const emptyCtx = harness();
    emptyCtx.coordinator.createEmpty("empty.md");
    await emptyCtx.core.write({ command: "read", file: "empty.md" }, context);

    const emptyInsert = await emptyCtx.core.write(
      { command: "insert", file: "empty.md", content: "Only block" },
      context,
    );

    expect(outcomeText(emptyInsert)).toContain("status: success");
    expect(blockTexts(emptyCtx.liveDoc("empty.md"))).toEqual(["Only block"]);
    expect(
      renderedBlockBodies(
        await emptyCtx.core.write({ command: "read", file: "empty.md" }, context),
      ),
    ).toEqual(["Only block"]);
  });

  it("replaces text, formatting, and deletes through replace(content='')", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword.\n\nDelete me." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

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

  it("replaces with a find needle copied from hash-prefixed read output", async () => {
    const ctx = harness({ "chapter.md": "The heavens rumbled...\n\nTail." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const firstHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const replaced = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "The sky split.",
        find: `${firstHash}|The heavens rumbled...`,
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["The sky split.", "Tail."]);
  });

  it("replaces a multi-block range with a find needle copied from hash-prefixed read output", async () => {
    const ctx = harness({ "chapter.md": "First.\n\nSecond.\n\nTail." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const firstHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    const secondHash = hashAt(ctx.liveDoc("chapter.md"), 1);

    const replaced = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Merged.",
        find: `${firstHash}|First.\n${secondHash}|Second.`,
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Merged.", "Tail."]);
  });

  it("replaces and inserts with find anchors copied from markdown-form read", async () => {
    const ctx = harness({
      "chapter.md":
        "Not burning — *thrumming.* Alive.\n\nHe could *feel* the qi in the air now — not as a vague warmth, but as a current.\n\nA **bold** anchor waits.",
    });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const replaced = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Not burning — humming. Alive.",
        find: "Not burning — *thrumming.* Alive.",
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Not burning — humming. Alive.");

    const inserted = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "!", find: "*feel*" },
      context,
    );

    expect(outcomeText(inserted)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[1]).toBe(
      "He could feel! the qi in the air now — not as a vague warmth, but as a current.",
    );

    const bold = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "strong", find: "**bold**" },
      context,
    );

    expect(outcomeText(bold)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[2]).toBe("A strong anchor waits.");
  });

  it("reconciles find replacements in markdown space without serialized-to-flat offset mapping", async () => {
    const ctx = harness({
      "chapter.md": "Before **bold** — after — **tail**.",
    });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const replaced = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: " ", find: "—", all: true },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Before bold   after   tail."]);
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toContain(
      "Before **bold**   after   **tail**.",
    );
    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(1);
  });

  it("inserts near markdown delimiters and preserves surrounding marks", async () => {
    const ctx = harness({ "chapter.md": "A **bold** marker and *italic* marker." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const inserted = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "!", find: "**bold**" },
      context,
    );

    expect(outcomeText(inserted)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["A bold! marker and italic marker."]);
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toContain(
      "A **bold**! marker and *italic* marker.",
    );
  });

  it("routes single-block find replacements that change block type through structural reconcile", async () => {
    const ctx = harness({ "chapter.md": "Opening line.\n\nTail." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const replaced = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "# Opening line.", find: "Opening line." },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(
      renderedBlockBodies(await ctx.core.write({ command: "read", file: "chapter.md" }, context)),
    ).toEqual(["# Opening line.", "Tail."]);
  });

  it("replaces and deletes find matches that span block boundaries", async () => {
    const replaceCtx = harness({ "chapter.md": "Alpha starts\n\nends Omega" });
    await replaceCtx.core.write({ command: "read", file: "chapter.md" }, context);

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
    await deleteCtx.core.write({ command: "read", file: "chapter.md" }, context);

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
    await insertCtx.core.write({ command: "read", file: "chapter.md" }, context);

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

  it("scopes find-based replace and insert to around windows", async () => {
    const replaceCtx = harness({ "chapter.md": aroundNeedleBlocks() });
    await replaceCtx.core.write({ command: "read", file: "chapter.md" }, context);
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
    await insertCtx.core.write({ command: "read", file: "chapter.md" }, context);
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
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

  it("returns LLM-readable not_found, ambiguous_match, and invalid_write errors", async () => {
    const ctx = harness({ "chapter.md": "sword one\n\nsword two" });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const missing = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "x", after: "deadbeef" },
      context,
    );
    expect(outcomeText(missing)).toContain("status: not_found");
    expectOutcome(missing, "not_found", true);
    expect(outcomeText(missing)).toContain('write(command="read", file="chapter.md")');

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
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

    const missing = await missingCtx.core.write({ command: "read", file: "missing.md" }, context);
    const missingEdit = await missingCtx.core.write(
      { command: "replace", file: "missing.md", find: "x", content: "y" },
      context,
    );

    expect(outcomeText(missing)).toContain("status: document_not_found");
    expectOutcome(missing, "document_not_found", true);
    expect(outcomeText(missingEdit)).toContain("status: document_not_found");
    expectOutcome(missingEdit, "document_not_found", true);

    const failingCtx = harness({ "chapter.md": "Alpha." });
    failingCtx.coordinator.failWith(new Error("database unavailable"));

    const transient = await failingCtx.core.write({ command: "read", file: "chapter.md" }, context);

    expect(outcomeText(transient)).toContain("status: internal_error");
    expectOutcome(transient, "internal_error", true);
    expect(outcomeText(transient)).not.toContain("database unavailable");
  });
});

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

function appendLiveBlock(doc: Y.Doc, markdown: string): void {
  doc.transact(
    () => {
      const blocks = model.getBlocks(doc);
      model.insertBlocks(doc, blocks.at(-1) ?? null, codec.parse(markdown));
    },
    { type: "human" },
  );
}

function clearLiveBlocks(doc: Y.Doc): void {
  doc.transact(
    () => {
      const fragment = fragmentOf(doc);
      fragment.delete(0, fragment.length);
    },
    { type: "human" },
  );
}
