// End-to-end write(command=...) coverage with in-memory port fakes.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { UpdateJournal } from "../ports/update-journal.js";
import {
  blockTexts,
  expectOutcome,
  hashAt,
  humanText,
  outcomeText,
  serializeDoc,
} from "./test-support/assertions.js";
import { codec, context, harness, model } from "./test-support/write-tool-harness.js";
import { createWriteTool } from "./write.js";

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
  it("returns exact logical read blocks in the versioned result envelope", async () => {
    const firstBody = "```text\nfirst line\nc3d4|looks like another block\n```";
    const ctx = harness({ "chapter.md": `${firstBody}\n\nActual block.` });

    const read = await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    expect(read.result).toMatchObject({
      schema: "meridian.agent-edit.v1",
      command: "read",
      status: "success",
      read: { format: "full" },
    });
    expect(read.result.blocks).toEqual([
      {
        extent: "full",
        relation: "document",
        items: [
          expect.objectContaining({ body: firstBody }),
          expect.objectContaining({ body: "Actual block." }),
        ],
      },
    ]);
  });

  it("reports degraded awareness when destructive reporting fails after append", async () => {
    const ctx = harness(
      { "chapter.md": "Writer protected." },
      {
        journalOverride: (journal) => {
          const destructiveJournal: UpdateJournal = journal;
          destructiveJournal.materializeDestructiveProvenance = async () => {
            throw new Error("classification failed");
          };
          return journal;
        },
      },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Writer protected.",
        content: "Agent replacement.",
      },
      context,
    );

    expectOutcome(result, "success");
    expect(outcomeText(result)).toContain("destructive awareness degraded");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Agent replacement."]);
  });

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

  it("replaces text and formatting, then structurally deletes and restores a block range", async () => {
    const ctx = harness({
      "chapter.md": "Alpha sword.\n\nDelete one.\n\n## Delete two\n\nKeep me.",
    });
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

    const beforeDelete = serializeDoc(ctx.liveDoc("chapter.md"));
    const firstDeleteHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const lastDeleteHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const deletion = await ctx.core.write(
      { command: "delete", file: "chapter.md", in: [firstDeleteHash, lastDeleteHash] },
      context,
    );

    expect(outcomeText(deletion)).toContain("status: success");
    expect(deletion.result).toMatchObject({
      command: "delete",
      write: { deletedHashes: [firstDeleteHash, lastDeleteHash] },
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade.", "Keep me."]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(undo.result).toMatchObject({
      command: "undo",
      reversal: { direction: "undo", count: 1 },
    });
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toBe(beforeDelete);

    const rejectedSentinel = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", in: 4 },
      context,
    );
    expect(rejectedSentinel.status).toBe("invalid_write");
    expect(outcomeText(rejectedSentinel)).toContain("Use the delete command");
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

  it("returns LLM-readable not_found, ambiguous_match, and invalid_write errors", async () => {
    const ctx = harness({ "chapter.md": "sword one\n\nsword two" });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    const missing = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "x", after: "deadbeef" },
      context,
    );
    expect(outcomeText(missing)).toContain("status: not_found");
    expectOutcome(missing, "not_found", true);
    expect(outcomeText(missing)).toContain('write(command="read", path="chapter.md")');

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
});

function appendLiveBlock(doc: Y.Doc, markdown: string): void {
  doc.transact(
    () => {
      const blocks = model.getBlocks(doc);
      model.insertBlocks(doc, blocks.at(-1) ?? null, codec.parse(markdown));
    },
    { type: "human" },
  );
}
