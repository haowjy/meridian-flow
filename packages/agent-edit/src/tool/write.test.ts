// End-to-end write(command=...) coverage with in-memory port fakes.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore, toDocHandle, type WriteIdempotencyHitDetail } from "../index.js";
import { fragmentOf } from "../model/y-prosemirror.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import {
  blockTexts,
  expectOutcome,
  hashAt,
  humanText,
  outcomeText,
  renderedBlockBodies,
  serializeDoc,
} from "./test-support/assertions.js";
import { codec, context, harness, model, THREAD_ID } from "./test-support/write-tool-harness.js";
import { createWriteTool } from "./write.js";

const INTERNAL_DOCUMENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const MODEL_PATH = "scratch://chapter-2.md";

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

describe("write tool dispatch", () => {
  it("leaves no phantom runtime mutation when write ordinal reservation fails", async () => {
    let reservations = 0;
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        journalOverride: (journal) => {
          const reserve = journal.reserveWriteOrdinal.bind(journal);
          journal.reserveWriteOrdinal = async (...args) => {
            reservations += 1;
            if (reservations === 1) throw new Error("forced ordinal failure");
            return reserve(...args);
          };
          return journal;
        },
      },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const failed = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Phantom." },
      context,
    );
    expectOutcome(failed, "internal_error", true);

    const durable = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Durable." },
      context,
    );
    expectOutcome(durable, "success");
    expect(outcomeText(durable)).not.toContain("Phantom");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Durable."]);
  });

  it("reports a pulled human edit once after a failed immediate write", async () => {
    const ctx = harness({
      "chapter.md": "Alpha target.\n\nBeta target.\n\nGamma target.",
    });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const _beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));

    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 0 }, "Human pulled. ");
    ctx.coordinator.failNextForDoc("chapter.md", new Error("branch snapshot failure"));

    const failed = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Alpha failed.",
      },
      {
        ...context,
        turnId: "turn-immediate-failed-pull",
        interactionContext: {
          mode: "threadPeer",
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    expectOutcome(failed, "internal_error", true);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha target.",
      "Human pulled. Beta target.",
      "Gamma target.",
    ]);

    const successful = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Alpha success.",
      },
      {
        ...context,
        turnId: "turn-immediate-success-after-failed-pull",
        interactionContext: {
          mode: "threadPeer",
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    const successfulText = outcomeText(successful);
    expectOutcome(successful, "success");
    expect(successfulText).toContain("Alpha success.");

    const next = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Gamma target.",
        content: "Gamma success.",
      },
      { ...context, turnId: "turn-immediate-no-reecho" },
    );

    expectOutcome(next, "success");
    expect(outcomeText(next)).not.toContain("concurrent edits:");
  });

  it("runs immediate interaction-baseline writes through the local-mutation sync path", async () => {
    const ctx = harness({ "chapter.md": "Alpha target.\n\nBeta target." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const _beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 0 }, "Human pulled. ");

    const concurrentUpdatesSince = vi.fn(async (input) => [
      {
        update: Y.encodeStateAsUpdate(input.doc, input.sinceStateVector),
        origin: { type: "human" as const, userId: "human-1" },
      },
    ]);
    ctx.coordinator.concurrentUpdatesSince = concurrentUpdatesSince;

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Alpha success.",
      },
      {
        ...context,
        turnId: "turn-immediate-baseline-sync-path",
        interactionContext: {
          mode: "threadPeer",
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    expectOutcome(result, "success");
    expect(concurrentUpdatesSince).toHaveBeenCalledTimes(1);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(outcomeText(result)).toContain("Human pulled. Beta target.");
  });

  it("keeps detection baseline clean when the own update comes from a post-pull runtime doc", async () => {
    const ctx = harness({ "chapter.md": "R10 X doomed.\n\nR10 Y survivor baseline." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const _beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));

    const live = ctx.liveDoc("chapter.md");
    const [xBlock] = model.getBlocks(toDocHandle(live));
    if (!xBlock) throw new Error("missing X block");
    model.deleteBlock(toDocHandle(live), xBlock);
    const survivingBlocks = model.getBlocks(toDocHandle(live));
    model.insertBlocks(
      toDocHandle(live),
      survivingBlocks.at(-1) ?? null,
      codec.parse("R10 Z foreign agent insert."),
    );

    let observedBaseline: string[] | undefined;
    ctx.coordinator.concurrentUpdatesSince = vi.fn(async (input) => {
      observedBaseline = input.baselineDoc ? blockTexts(input.baselineDoc) : undefined;
      return [];
    });

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "survivor",
        content: "survivor A-R10-AFTER",
      },
      {
        ...context,
        turnId: "turn-r10-clean-detection-baseline",
        interactionContext: {
          mode: "threadPeer",
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    expectOutcome(result, "success");
    expect(observedBaseline).toEqual(["R10 Y survivor baseline.", "R10 Z foreign agent insert."]);
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

  it("passes the durable attempt id through immediate create overwrite commits", async () => {
    const ctx = harness({ "chapter.md": "Old body." });
    let capturedAttemptId: string | undefined;
    ctx.coordinator.concurrentUpdatesSince = async (input) => {
      capturedAttemptId = input.attemptId;
      return [];
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "New body.",
        overwrite: true,
      },
      { ...context, turnId: "turn-create-overwrite-attempt" },
    );

    expectOutcome(result, "success");
    expect(capturedAttemptId).toBe(ctx.journal.mutationRecords("chapter.md")[0]?.writeId);
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

  it.each([
    {
      shape: "code block",
      before: "```ts\nconst oldValue = 1;\n```",
      after: "```ts\nconst newValue = 2;\n```",
    },
    { shape: "list", before: "- old one\n- old two", after: "- new one\n- new two" },
    { shape: "blockquote", before: "> old quote", after: "> new quote" },
    { shape: "horizontal rule", before: "---", after: "---" },
  ])("overwrites a same-type $shape in place", async ({ before, after }) => {
    const ctx = harness({ "chapter.md": before });
    const originalHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: after, overwrite: true },
      context,
    );

    expectOutcome(result, "success");
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toBe(
      codec.serialize(codec.parse(after).blocks),
    );
    expect(hashAt(ctx.liveDoc("chapter.md"), 0)).toBe(originalHash);
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

  it("produces the exact block structure for an incompatible equal-length overwrite", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nBeta.\n\nGamma." });

    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "# First\n\n## Second\n\n### Third",
        overwrite: true,
      },
      context,
    );

    expectOutcome(result, "success");
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toBe("# First\n\n## Second\n\n### Third\n");
    expect(model.getBlocks(ctx.liveDoc("chapter.md"))).toHaveLength(3);
  });

  it("fully replaces canonical blocks on staged stale-replica create overwrite", async () => {
    const ctx = harness({ "chapter.md": "Alpha canonical." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    appendLiveBlock(ctx.liveDoc("chapter.md"), "Beta canonical.");
    const responseContext = {
      ...context,
      turnId: "turn-staged-overwrite-stale",
      responseId: "response-staged-overwrite-stale",
      createdDocument: false,
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

  it("keeps single-newline create overwrite content on the normal markdown parse path", async () => {
    const ctx = harness({ "chapter.md": "Alpha\n\nBeta\n\nGamma" });
    const poem = "line 1\nline 2\nline 3";
    const responseContext = {
      ...context,
      turnId: "turn-staged-overwrite-poem",
      responseId: "response-staged-overwrite-poem",
      createdDocument: false,
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: poem,
        overwrite: true,
      },
      responseContext,
    );

    expectOutcome(result, "success");

    await ctx.core.commitResponse("response-staged-overwrite-poem");

    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toBe(codec.serialize(codec.parse(poem).blocks));
  });

  it("stages create overwrite as a full replacement for reordered whole-doc content", async () => {
    const ctx = harness({ "chapter.md": "Alpha\n\nBeta\n\nGamma" });
    const replacement = "Gamma revised.\n\nAlpha revised.\n\nBeta revised.";
    const responseContext = {
      ...context,
      turnId: "turn-staged-overwrite-reorder",
      responseId: "response-staged-overwrite-reorder",
      createdDocument: false,
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: replacement,
        overwrite: true,
      },
      responseContext,
    );

    expectOutcome(result, "success");

    await ctx.core.commitResponse("response-staged-overwrite-reorder");

    expect(
      renderedBlockBodies(await ctx.core.write({ command: "read", file: "chapter.md" }, context)),
    ).toEqual(["Gamma revised.", "Alpha revised.", "Beta revised."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).not.toContain("Gamma");
  });

  it("ensures existing staged create targets before probing live state", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-existing-without-live",
      responseId: "response-staged-existing-without-live",
      createdDocument: false,
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "existing-row-no-live.md",
        content: "Seeded existing row now has live state.",
        overwrite: true,
      },
      responseContext,
    );

    expectOutcome(result, "success");
    expect(blockTexts(ctx.liveDoc("existing-row-no-live.md"))).toEqual([]);

    await ctx.core.commitResponse("response-staged-existing-without-live");

    expect(
      renderedBlockBodies(
        await ctx.core.write({ command: "read", file: "existing-row-no-live.md" }, context),
      ),
    ).toEqual(["Seeded existing row now has live state."]);
  });

  it("keeps staged new-document create behavior unchanged", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-new-doc-create",
      responseId: "response-staged-new-doc-create",
      createdDocument: true,
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "new.md",
        content: "# New Draft\n\nOpening line.",
      },
      responseContext,
    );

    expectOutcome(result, "success");
    expect(() => ctx.liveDoc("new.md")).toThrow();

    await ctx.core.commitResponse("response-staged-new-doc-create");

    expect(
      renderedBlockBodies(await ctx.core.write({ command: "read", file: "new.md" }, context)),
    ).toEqual(["# New Draft", "Opening line."]);
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
    expect(outcomeText(result)).not.toContain("Phantom replica content.");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Fresh canonical content."]);

    expect(
      renderedBlockBodies(await ctx.core.write({ command: "read", file: "chapter.md" }, context)),
    ).toEqual(["Fresh canonical content."]);
    const phantomReplace = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Leaked.",
        find: "Phantom replica content.",
      },
      context,
    );
    expectOutcome(phantomReplace, "not_found", true);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Fresh canonical content."]);
  });

  it.each([
    { label: "non-overwrite", overwrite: false },
    { label: "overwrite", overwrite: true },
  ])("creates a fresh staged $label document without live document creation", async ({
    overwrite,
  }) => {
    const ctx = harness();
    const responseId = `response-staged-create-new-${overwrite ? "overwrite" : "default"}`;
    const responseContext = {
      ...context,
      turnId: `turn-staged-create-new-${overwrite ? "overwrite" : "default"}`,
      responseId,
      createdDocument: true,
    };

    const result = await ctx.core.write(
      {
        command: "create",
        file: "new.md",
        content: "Fresh content.",
        ...(overwrite ? { overwrite: true } : {}),
      },
      responseContext,
    );

    expectOutcome(result, "success");
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);

    const commit = await ctx.core.commitResponse(responseId);
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.stagedCreates).toEqual({ committed: ["new.md"], discarded: [] });
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Fresh content."]);
  });

  it.each([
    {
      label: "rejects",
      overwrite: false,
      expectedOutcome: "invalid_write" as const,
      expectedContent: "First staged content.",
    },
    {
      label: "overwrites",
      overwrite: true,
      expectedOutcome: "success" as const,
      expectedContent: "Replacement staged content.",
    },
  ])("$label a duplicate staged create for the same new document in one response", async ({
    overwrite,
    expectedOutcome,
    expectedContent,
  }) => {
    const ctx = harness();
    const responseId = `response-staged-duplicate-${overwrite ? "overwrite" : "create"}`;
    const responseContext = {
      ...context,
      turnId: `turn-staged-duplicate-${overwrite ? "overwrite" : "create"}`,
      responseId,
      createdDocument: true,
    };

    const first = await ctx.core.write(
      { command: "create", file: "new.md", content: "First staged content." },
      responseContext,
    );
    const second = await ctx.core.write(
      {
        command: "create",
        file: "new.md",
        content: "Replacement staged content.",
        ...(overwrite ? { overwrite: true } : {}),
      },
      responseContext,
    );

    expectOutcome(first, "success");
    expectOutcome(second, expectedOutcome, expectedOutcome === "invalid_write");
    if (expectedOutcome === "invalid_write") {
      expect(outcomeText(second)).toContain("File already exists: new.md");
    }
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);

    await ctx.core.commitResponse(responseId);

    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual([expectedContent]);
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

  it("scopes tool_use_id idempotency to the response identity", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const first = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "First response write.",
        tool_use_id: "provider-local-write",
      },
      {
        ...context,
        turnId: "turn-provider-local-a",
        responseId: "response-provider-local-a",
      },
    );
    await ctx.core.commitResponse("response-provider-local-a");

    const second = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "Second response write.",
        tool_use_id: "provider-local-write",
      },
      {
        ...context,
        turnId: "turn-provider-local-b",
        responseId: "response-provider-local-b",
      },
    );
    await ctx.core.commitResponse("response-provider-local-b");

    expectOutcome(first, "success");
    expectOutcome(second, "success");
    expect(first.writeId).toBe("w1");
    expect(second.writeId).toBe("w2");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha.",
      "First response write.",
      "Second response write.",
    ]);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(2);
    expect(ctx.journal.mutationRecords("chapter.md").map((row) => row.writeId)).toEqual([
      "response:response-provider-local-a:tool:provider-local-write",
      "response:response-provider-local-b:tool:provider-local-write",
    ]);
  });

  it("rejects tool_use_id replay after rollback instead of returning cached staged success", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-idempotency-after-rollback",
      responseId: "response-idempotency-after-rollback",
    };
    const command = {
      command: "insert" as const,
      file: "chapter.md",
      content: "Rolled back write.",
      tool_use_id: "rollback-replay-write",
    };

    const first = await ctx.core.write(command, responseContext);
    expectOutcome(first, "success");
    await ctx.core.rollbackResponse("response-idempotency-after-rollback");

    const replay = await ctx.core.write(command, responseContext);

    expectOutcome(replay, "invalid_write", true);
    expect(outcomeText(replay)).toContain("Response lifecycle closed");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
  });

  it("keeps same-response tool_use_id retries idempotent", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-same-response-retry",
      responseId: "response-same-response-retry",
    };
    const command = {
      command: "insert" as const,
      file: "chapter.md",
      content: "Retried response write.",
      tool_use_id: "retry-local-write",
    };

    const first = await ctx.core.write(command, responseContext);
    const retry = await ctx.core.write(command, responseContext);
    await ctx.core.commitResponse("response-same-response-retry");

    expect(retry).toBe(first);
    expectOutcome(first, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Retried response write."]);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(1);
  });

  it("emits onIdempotencyHit for same-response replays only", async () => {
    const hits: WriteIdempotencyHitDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onIdempotencyHit: (event) => {
          hits.push(event);
        },
      },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-idempotency-observer",
      responseId: "response-idempotency-observer",
    };
    const command = {
      command: "insert" as const,
      file: "chapter.md",
      content: "Observed retry.",
      tool_use_id: "observed-retry",
    };

    const first = await ctx.core.write(command, responseContext);
    const retry = await ctx.core.write(command, responseContext);
    await ctx.core.commitResponse("response-idempotency-observer");

    expect(retry).toBe(first);
    expect(hits).toEqual([
      {
        toolUseId: "observed-retry",
        scopeKind: "response",
        scopeId: "response-idempotency-observer",
        sessionId: "session-a",
        outcome: { status: "success", phase: "staged" },
      },
    ]);
  });

  it("brands staged mutating success with phase staged and immediate commit with committed", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const staged = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "Staged line.",
      },
      {
        ...context,
        turnId: "turn-phase-staged",
        responseId: "response-phase-staged",
      },
    );
    expect(staged.status).toBe("success");
    if (staged.status === "success") expect(staged.phase).toBe("staged");

    const committed = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "Committed line.",
      },
      context,
    );
    expect(committed.status).toBe("success");
    if (committed.status === "success") expect(committed.phase).toBe("committed");
  });

  it("falls back to turn identity when tool_use_id has no response id", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const command = {
      command: "insert" as const,
      file: "chapter.md",
      content: "Turn-scoped write.",
      tool_use_id: "turn-local-write",
    };

    const first = await ctx.core.write(command, {
      ...context,
      turnId: "turn-local-a",
    });
    const second = await ctx.core.write(command, {
      ...context,
      turnId: "turn-local-b",
    });

    expectOutcome(first, "success");
    expectOutcome(second, "success");
    expect(first.writeId).toBe("w1");
    expect(second.writeId).toBe("w2");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(2);
    expect(ctx.journal.mutationRecords("chapter.md").map((row) => row.writeId)).toEqual([
      "turn:turn-local-a:tool:turn-local-write",
      "turn:turn-local-b:tool:turn-local-write",
    ]);
  });

  it("keeps staged replace-only edits clean", async () => {
    const ctx = harness({ "chapter.md": "Alpha\n\nBeta\n\nGamma" });
    const responseContext = {
      ...context,
      turnId: "turn-staged-replace-clean",
      responseId: "response-staged-replace-clean",
    };

    const result = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Beta", content: "Beta revised" },
      responseContext,
    );

    expectOutcome(result, "success");

    await ctx.core.commitResponse("response-staged-replace-clean");

    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha", "Beta revised", "Gamma"]);
  });

  it("allows staged appends with genuinely new top-level content", async () => {
    const ctx = harness({ "chapter.md": "Alpha\n\nBeta\n\nGamma" });
    const responseContext = {
      ...context,
      turnId: "turn-staged-new-append",
      responseId: "response-staged-new-append",
    };

    const result = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Delta\n\nEpsilon" },
      responseContext,
    );

    expectOutcome(result, "success");

    await ctx.core.commitResponse("response-staged-new-append");

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
  });

  it("allows staged inserts even when content repeats existing text", async () => {
    const ctx = harness({ "chapter.md": "Alpha\n\nBeta\n\nGamma" });
    const responseContext = {
      ...context,
      turnId: "turn-staged-insert-repeat",
      responseId: "response-staged-insert-repeat",
    };

    const result = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Alpha repeated.\n\nBeta repeated." },
      responseContext,
    );

    expectOutcome(result, "success");

    await ctx.core.commitResponse("response-staged-insert-repeat");

    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Alpha repeated.",
      "Beta repeated.",
    ]);
  });

  it("turns the recreate step in a move-flailing sequence into a full replacement", async () => {
    const ctx = harness({
      "chapter.md": "Alpha anchor paragraph.\n\nBeta paragraph.\n\nGamma final paragraph.",
    });
    const responseContext = {
      ...context,
      turnId: "turn-staged-move-flail",
      responseId: "response-staged-move-flail",
      createdDocument: false,
    };

    const replace = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Beta paragraph.",
        content: "Beta revised paragraph.",
      },
      responseContext,
    );
    const failedReorder = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Beta revised paragraph.\nGamma final paragraph.",
        content: "Gamma final paragraph.\nBeta revised paragraph.",
      },
      responseContext,
    );
    const recreate = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        overwrite: true,
        content: "Gamma final paragraph.\n\nBeta revised paragraph.\n\nAlpha anchor paragraph.",
      },
      responseContext,
    );

    expectOutcome(replace, "success");
    expectOutcome(failedReorder, "not_found", true);
    expectOutcome(recreate, "success");

    await ctx.core.commitResponse("response-staged-move-flail");

    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(2);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(2);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Gamma final paragraph.",
      "Beta revised paragraph.",
      "Alpha anchor paragraph.",
    ]);
  });

  it("applies subsequent same-response writes on top of create overwrite", async () => {
    const ctx = harness({ "chapter.md": "Alpha\n\nBeta" });
    const responseContext = {
      ...context,
      turnId: "turn-staged-overwrite-then-edit",
      responseId: "response-staged-overwrite-then-edit",
      createdDocument: false,
    };

    const overwrite = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        overwrite: true,
        content: "Gamma\n\nDelta",
      },
      responseContext,
    );
    const replace = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Delta", content: "Delta revised" },
      responseContext,
    );

    expectOutcome(overwrite, "success");
    expectOutcome(replace, "success");

    await ctx.core.commitResponse("response-staged-overwrite-then-edit");

    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(2);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(2);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Gamma", "Delta revised"]);
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

    await ctx.core.invalidateThread("chapter.md", THREAD_ID);
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

  it("applies unequal-length find-all replaces on a plain block without span drift", async () => {
    const ctx = harness({ "chapter.md": "cat and cat" });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const beforeBlock = model.getBlocks(ctx.liveDoc("chapter.md"))[0];
    if (!beforeBlock) throw new Error("missing source block");
    const writerGapRoots = lineageUnits(model.getVisibleContentLineage(beforeBlock)).slice(3, 8);

    const replaced = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "kitten", find: "cat", all: true },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["kitten and kitten"]);
    const afterBlock = model.getBlocks(ctx.liveDoc("chapter.md"))[0];
    if (!afterBlock) throw new Error("missing replaced block");
    expect(lineageUnits(model.getVisibleContentLineage(afterBlock)).slice(6, 11)).toEqual(
      writerGapRoots,
    );
    const semanticIr = ctx.journal.recordedBatchEntries()[0]?.[0]?.mutation?.semanticEditIr;
    expect(
      semanticIr?.intent.kind === "mappedEdits"
        ? semanticIr.intent.edits.flatMap(({ outputRuns }) => outputRuns)
        : [],
    ).toContainEqual({
      kind: "preserved",
      source: { clientID: writerGapRoots[0]?.clientID, clock: writerGapRoots[0]?.clock, length: 5 },
      output: { from: 6, to: 11 },
      materialization: "retained",
    });
    expect(ctx.journal.mutationRecords("chapter.md")).toHaveLength(1);
  });

  it("does not rematerialize provenance for roots retained by a multi-range edit", async () => {
    const writeCertifiedFacts = vi.fn();
    const ctx = harness(
      { "chapter.md": "cat and cat" },
      { semanticProvenance: { writeCertifiedFacts } },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const replaced = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "kitten", find: "cat", all: true },
      context,
    );

    expectOutcome(replaced, "success");
    expect(writeCertifiedFacts).not.toHaveBeenCalled();
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["kitten and kitten"]);
  });

  it("forwards semantic provenance and restores the runtime if its writer rejects", async () => {
    const writeCertifiedFacts = vi.fn(() => {
      throw new Error("forced provenance rejection");
    });
    const ctx = harness(
      { "chapter.md": "cat one" },
      { semanticProvenance: { writeCertifiedFacts } },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const failed = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "kitten", find: "cat" },
      context,
    );
    expectOutcome(failed, "internal_error", true);
    expect(writeCertifiedFacts).toHaveBeenCalledOnce();

    const reread = await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    expectOutcome(reread, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["cat one"]);
  });

  it.each([
    ["block start", "cat middle cat tail", " middle  tail"],
    ["block end", "head cat middle cat", "head  middle "],
    ["both block ends", "cat middle cat", " middle "],
    ["block interior", "head cat middle cat tail", "head  middle  tail"],
  ])("deletes every find-all match at the %s without changing surrounding text", async (_position, source, expected) => {
    const ctx = harness({ "chapter.md": source });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const deleted = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", find: "cat", all: true },
      context,
    );

    expectOutcome(deleted, "success");
    const block = model.getBlocks(ctx.liveDoc("chapter.md"))[0];
    expect(block ? model.getText(block) : undefined).toBe(expected);
  });

  it("replaces adjacent structural find-all groups without stale predecessor anchors", async () => {
    const ctx = harness({ "chapter.md": "cat\n\ncat" });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const replaced = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "# kitten", find: "cat", all: true },
      context,
    );

    expectOutcome(replaced, "success");
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toBe("# kitten\n\n# kitten\n");
  });

  it("restores the pre-write runtime snapshot after an apply failure", async () => {
    let inlineApplications = 0;
    const rejectingModel = {
      ...model,
      applyInlineReplacement(...args: Parameters<typeof model.applyInlineReplacement>) {
        inlineApplications += 1;
        if (inlineApplications === 2) {
          return {
            ok: false as const,
            code: "invalid_write" as const,
            message: "forced second-block rejection",
          };
        }
        return model.applyInlineReplacement(...args);
      },
    };
    const ctx = harness({ "chapter.md": "cat one\n\ncat two" }, { model: rejectingModel });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const failed = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "kitten", find: "cat", all: true },
      context,
    );
    expectOutcome(failed, "invalid_write", true);

    const retry = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "lynx", find: "cat one" },
      context,
    );
    expectOutcome(retry, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["lynx", "cat two"]);
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

function lineageUnits(
  ranges: readonly { clientID: number; clock: number; length: number }[],
): Array<{ clientID: number; clock: number }> {
  return ranges.flatMap((range) =>
    Array.from({ length: range.length }, (_, offset) => ({
      clientID: range.clientID,
      clock: range.clock + offset,
    })),
  );
}
