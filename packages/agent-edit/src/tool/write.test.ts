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
} from "./test-support/assertions.js";
import { codec, context, harness, model } from "./test-support/write-tool-harness.js";

describe("write tool dispatch", () => {
  it("returns exact logical read blocks in the versioned result envelope", async () => {
    const firstBody = "```text\nfirst line\nc3d4|looks like another block\n```";
    const ctx = harness({ "chapter.md": `${firstBody}\n\nActual block.` });

    const read = await ctx.core.read({ file: "chapter.md" }, context);

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
    const transitions: string[] = [];
    const ctx = harness(
      { "chapter.md": "Writer protected." },
      {
        onResponseCommitterTransition: (event) => transitions.push(event.transition),
        journalOverride: (journal) => {
          const destructiveJournal: UpdateJournal = journal;
          destructiveJournal.materializeDestructiveProvenance = async () => {
            throw new Error("classification failed");
          };
          return journal;
        },
      },
    );
    await ctx.core.read({ file: "chapter.md" }, context);

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
    const staged = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Agent replacement.",
        content: "Accepted response text.",
      },
      {
        ...context,
        responseIdentity: { providerResponseId: "report-failure", editScopeId: "report-failure" },
        turnId: "report-failure",
      },
    );
    expectOutcome(staged, "success");
    const committed = await ctx.core.commitResponse("report-failure");
    expect(committed.documents[0].receipts).toMatchObject([
      { writeId: staged.result.write?.id, result: { status: "success", awarenessDegraded: true } },
    ]);
    expect(transitions).not.toContain("recovery_succeeded");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Accepted response text."]);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(2);
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
    await ctx.core.read({ file: "chapter.md" }, context);

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
    await ctx.core.read({ file: "chapter.md" }, context);

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
          peerBranchId: "branch-peer",
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
          peerBranchId: "branch-peer",
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
    await ctx.core.read({ file: "chapter.md" }, context);
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

  it("rejects create for a non-empty file with overwrite guidance, even one filled just before admission", async () => {
    const ctx = harness({ "chapter.md": "Already here." });

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Replacement." },
      context,
    );

    expect(outcomeText(result)).toContain("status: invalid_write");
    expectOutcome(result, "invalid_write", true);
    expect(outcomeText(result)).toContain(
      "File already exists: chapter.md. Read it, then edit it; use overwrite=true only to replace all of its content.",
    );
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Already here."]);

    // A host's fresh bound write: empty when checked and restored, then a writer's paragraph is
    // admitted once the write's content exists in its runtime copy, before the write's own admission.
    // (A writer admitted after that admission copy is the accepted L35 window, not asserted here.)
    let writerLanded: Promise<void> | undefined;
    const raced = harness(
      {},
      {
        createRuntimeDoc() {
          const runtime = new Y.Doc({ gc: false });
          runtime.on("afterTransaction", () => {
            if (writerLanded || model.getBlocks(runtime).length === 0) return;
            const live = raced.liveDoc("chapter.md");
            const vector = Y.encodeStateVector(live);
            live.transact(
              () => model.insertBlocks(live, null, codec.parse("Writer content.")),
              "writer",
            );
            writerLanded = raced.journal
              .append("chapter.md", Y.encodeStateAsUpdate(live, vector), {
                origin: "human:writer",
                seq: 0,
              })
              .then(() => undefined);
          });
          return runtime;
        },
      },
    );
    const fresh = await raced.core.write(
      { command: "create", file: "chapter.md", content: "Fresh bound." },
      {
        ...context,
        actor: { kind: "human", userId: "saver", threadId: context.threadId },
        boundNodes: codec.parse("Fresh bound.").blocks,
      },
    );
    expect(writerLanded).toBeDefined();
    await writerLanded;
    expectOutcome(fresh, "invalid_write", true);
    expect(outcomeText(fresh)).toContain("File already exists: chapter.md");
    expect(blockTexts(raced.liveDoc("chapter.md"))).toEqual(["Writer content."]);
    expect((await raced.journal.read("chapter.md")).updates).toHaveLength(1);
  });

  it("inserts by block hash, by find, and deduplicates tool_use_id", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nOmega." });
    await ctx.core.read({ file: "chapter.md" }, context);
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

  it("finds the writer's text and the escaped form a read showed", async () => {
    const ctx = harness({ "chapter.md": "Cast LIVE\\_ONLY at \\*dawn\\*.\n\nOmega." });
    const read = await ctx.core.read({ file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("Cast LIVE\\_ONLY at \\*dawn\\*.");

    const plain = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "DRAFT_ONLY", find: "LIVE_ONLY" },
      context,
    );
    expectOutcome(plain, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Cast DRAFT_ONLY at *dawn*.");

    const escaped = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "dusk", find: "\\*dawn\\*" },
      context,
    );
    expectOutcome(escaped, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Cast DRAFT_ONLY at dusk.");

    const partial = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "-LATE", find: "_ONLY" },
      context,
    );
    expectOutcome(partial, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Cast DRAFT-LATE at dusk.");
  });

  it("scopes tool_use_id idempotency to the response identity", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const appended = vi.spyOn(ctx.journal, "appendBatch");
    await ctx.core.read({ file: "chapter.md" }, context);

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
        responseIdentity: {
          providerResponseId: "response-provider-local-a",
          editScopeId: "response-provider-local-a",
        },
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
        responseIdentity: {
          providerResponseId: "response-provider-local-b",
          editScopeId: "response-provider-local-b",
        },
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
    expect(
      appended.mock.calls.flatMap(([entries]) => entries.map((entry) => entry.mutation?.writeId)),
    ).toEqual([
      "response:response-provider-local-a:tool:provider-local-write",
      "response:response-provider-local-b:tool:provider-local-write",
    ]);
  });

  it("hands the model's own tool call id to the journal, unscoped", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const appended = vi.spyOn(ctx.journal, "appendBatch");

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta.", tool_use_id: "call-write-9" },
      {
        ...context,
        turnId: "turn-9",
        responseIdentity: { providerResponseId: "response-9", editScopeId: "response-9" },
      },
    );
    await ctx.core.commitResponse("response-9");

    const mutations = appended.mock.calls.flatMap(([entries]) =>
      entries.map((entry) => entry.mutation),
    );
    expect(mutations).toEqual([
      expect.objectContaining({
        turnId: "turn-9",
        toolCallId: "call-write-9",
        writeId: "response:response-9:tool:call-write-9",
      }),
    ]);
  });

  it("rejects tool_use_id replay after rollback instead of returning cached staged success", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-idempotency-after-rollback",
      responseIdentity: {
        providerResponseId: "response-idempotency-after-rollback",
        editScopeId: "response-idempotency-after-rollback",
      },
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

  it("restores the pre-write runtime snapshot after an apply failure", async () => {
    let inlineApplications = 0;
    const rejectingModel = {
      ...model,
      applyInlineReplacements(...args: Parameters<typeof model.applyInlineReplacements>) {
        inlineApplications += 1;
        if (inlineApplications === 2) {
          return {
            ok: false as const,
            code: "invalid_write" as const,
            message: "forced second-block rejection",
          };
        }
        return model.applyInlineReplacements(...args);
      },
    };
    const ctx = harness({ "chapter.md": "cat one\n\ncat two" }, { model: rejectingModel });
    await ctx.core.read({ file: "chapter.md" }, context);

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

  it("maps typed missing documents differently from transient coordinator failures", async () => {
    const missingCtx = harness();

    const missing = await missingCtx.core.read({ file: "missing.md" }, context);
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

    const transient = await failingCtx.core.read({ file: "chapter.md" }, context);

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
    await ctx.core.read({ file: "chapter.md" }, context);

    const failed = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "kitten", find: "cat" },
      context,
    );
    expectOutcome(failed, "partial_failure", true);
    expect(writeCertifiedFacts).toHaveBeenCalledOnce();

    const reread = await ctx.core.read({ file: "chapter.md" }, context);
    expectOutcome(reread, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["cat one"]);
    for (const command of [
      {
        command: "replace" as const,
        file: "chapter.md",
        in: [1, 2] as [number, number],
        content: "kitten one\n\nkitten two",
      },
      {
        command: "create" as const,
        file: "chapter.md",
        overwrite: true,
        content: "kitten one\n\nkitten two",
      },
    ]) {
      let certified = 0;
      const multipart = harness(
        { "chapter.md": "cat one\n\ncat two" },
        {
          semanticProvenance: {
            writeCertifiedFacts() {
              if (++certified === 2) throw new Error("second part rejected");
            },
          },
        },
      );
      const rejected = await multipart.core.write(command, {
        ...context,
        responseIdentity: { providerResponseId: "certification", editScopeId: "certification" },
        createdDocument: false,
      });
      expectOutcome(rejected, "partial_failure", true);
      expect(certified).toBe(2);
      expect((await multipart.core.commitResponse("certification")).updateCount).toBe(0);
      expect((await multipart.journal.read("chapter.md")).updates).toHaveLength(0);
      expect(blockTexts(multipart.liveDoc("chapter.md"))).toEqual(["cat one", "cat two"]);
    }
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
