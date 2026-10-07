// Response-staging lifecycle and commit/rollback contracts.
import { describe, expect, it, vi } from "vitest";
import { renderAgentEditResult } from "./result-text.js";
import {
  blockTexts,
  expectOutcome,
  humanText,
  outcomeText,
  renderedBlockBodies,
} from "./test-support/assertions.js";
import { context, harness, model, THREAD_ID } from "./test-support/write-tool-harness.js";

const EMPTY_NOTE = "document is now empty; its one blank block always stays.";

describe("response staging", () => {
  it("does not retain a staged write when echo summarization fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-echo-summary-failure";
    await ctx.core.read({ file: "chapter.md" }, context);
    const originalSerialize = model.serializeBlockLines.bind(model);
    const serialize = vi
      .spyOn(model, "serializeBlockLines")
      .mockImplementationOnce(originalSerialize)
      .mockImplementationOnce(originalSerialize)
      .mockImplementationOnce(originalSerialize)
      .mockImplementationOnce(() => {
        throw new Error("echo summary failed");
      });

    const result = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Must not persist." },
      { ...context, turnId: "turn-echo-summary-failure", responseId },
    );
    serialize.mockRestore();

    expect(result).toMatchObject({ status: "internal_error", isError: true });
    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      documentCount: 0,
      updateCount: 0,
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
  });

  it("rolls back staged create without leaving an empty live document", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create-rollback",
      responseId: "response-staged-create-rollback",
      createdDocument: true,
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
    expect(outcomeText(await ctx.core.read({ file: "new.md" }, context))).toBe(
      "status: document_not_found; path: new.md\n\nFile not found. Check the path with `ls`.",
    );
  });

  it("rejects writes staged against committed response ids with a typed tool error", async () => {
    const lifecycleErrors: unknown[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseLifecycleError: (event) => lifecycleErrors.push(event) },
    );
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-committed-response",
      responseId: "response-committed-response",
    };

    await expect(
      ctx.core.write(
        { command: "insert", file: "chapter.md", content: "Committed write." },
        responseContext,
      ),
    ).resolves.toMatchObject({ status: "success" });
    await ctx.core.commitResponse("response-committed-response");

    const rejected = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "Must not stage.",
        tool_use_id: "closed-response-call",
      },
      {
        ...context,
        turnId: "turn-after-commit",
        responseId: "response-committed-response",
      },
    );

    expectOutcome(rejected, "invalid_write", true);
    expect(outcomeText(rejected)).toContain("Response lifecycle closed");
    expect(outcomeText(rejected)).toContain("response-committed-response");
    expect(rejected.error).toEqual({
      type: "response_lifecycle",
      code: "response_closed",
      responseId: "response-committed-response",
      operation: "stage",
      state: "committed",
      documentId: "chapter.md",
      threadId: THREAD_ID,
      turnId: "turn-after-commit",
      writeId: "response:response-committed-response:tool:closed-response-call",
    });
    expect(lifecycleErrors).toEqual([rejected.error]);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Committed write."]);
  });

  it("stages multiple response writes and commits journal plus live doc once", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
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
    expect(
      outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma."]);
    expect(
      outcomeText(await ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma.", "Delta."]);

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Epsilon." },
      {
        ...context,
        turnId: "turn-response-staging-next",
        responseId: "response-staging-next",
      },
    );
    await ctx.core.commitResponse("response-staging-next");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha.",
      "Beta.",
      "Gamma.",
      "Delta.",
      "Epsilon.",
    ]);
  });

  it("resyncs staged response views from live while preserving staged edits on another block", async () => {
    const ctx = harness({ "chapter.md": "Alpha waits.\n\nBravo waits." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-read-resync-other-block",
      responseId: "response-staged-read-resync-other-block",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 5 }, "Human");

    const review = await ctx.core.read({ file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha waits.", "Human waits."]);
  });

  it("keeps a writer's words typed into the block a reply replaces, and says so at the save", async () => {
    const ctx = harness({ "chapter.md": "# Race\n\nAlpha para.\n\nBeta para." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-same-block",
      responseId: "response-same-block",
    };
    await ctx.core.write(
      { command: "replace", file: "chapter.md", in: 2, content: "Alpha AI edit." },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 11, to: 11 }, " SAME_BLOCK_WRITER");

    const committed = await ctx.core.commitResponse("response-same-block");

    // The document holds the writer's text, never its markdown escapes.
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Race",
      "Alpha AI edit. SAME_BLOCK_WRITER",
      "Beta para.",
    ]);
    const receipt = committed.documents[0]?.receipts.at(-1)?.result;
    if (!receipt) throw new Error("missing settled receipt");
    const text = renderAgentEditResult(receipt);
    expect(text).toContain("concurrent user content swept during commit; re-read required");
    expect(text).toMatch(/swept: [0-9a-f]+\|Alpha para\. SAME\\_BLOCK\\_WRITER/);
  });

  it("reports no sweep when a reply removes and replaces the writer's text it asked to", async () => {
    const ctx = harness({ "chapter.md": "# Race\n\nAlpha para.\n\nBeta para.\n\nGamma para." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-own-removal",
      responseId: "response-own-removal",
    };
    await ctx.core.write({ command: "remove", file: "chapter.md", in: [2, 3] }, responseContext);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", in: 2, content: "Gamma AI edit." },
      responseContext,
    );

    const committed = await ctx.core.commitResponse("response-own-removal");

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Race", "Gamma AI edit."]);
    expect(committed.documents[0]?.lateSweep).toBeUndefined();
    for (const receipt of committed.documents[0]?.receipts ?? []) {
      expect(renderAgentEditResult(receipt.result)).not.toContain("swept");
    }
  });

  it("never saves a reply early for an undo; the host must save it first", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-undo-mid",
      responseId: "response-undo-mid",
    };
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, responseContext);

    expect(undo).toMatchObject({ status: "internal_error", isError: true });

    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    await expect(ctx.core.commitResponse("response-undo-mid")).resolves.toMatchObject({
      updateCount: 1,
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("says in the settled receipt when a write leaves the document empty", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nBeta.\n\nGamma." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = { ...context, turnId: "turn-empty", responseId: "response-empty" };
    const staged = await ctx.core.write(
      { command: "remove", file: "chapter.md", in: [1, 3] },
      responseContext,
    );
    expect(outcomeText(staged)).toContain(EMPTY_NOTE);

    const committed = await ctx.core.commitResponse("response-empty");
    const receipt = committed.documents[0]?.receipts.at(-1)?.result;
    if (!receipt) throw new Error("missing settled receipt");
    expect(renderAgentEditResult(receipt)).toContain(EMPTY_NOTE);
  });

  it("drops staged response buffers when invalidating a thread", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      {
        ...context,
        turnId: "turn-stale-buffer",
        responseId: "response-stale-buffer",
      },
    );

    await ctx.core.invalidateThread("chapter.md", THREAD_ID);
    await expect(ctx.core.commitResponse("response-stale-buffer")).rejects.toThrow(
      "already rolled back",
    );
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const read = await ctx.core.read({ file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("|Alpha.");
    expect(outcomeText(read)).not.toContain("Beta.");
  });

  it("rolls back staged response writes and restores the runtime doc from live", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
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
    const read = await ctx.core.read({ file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("Alpha.");
    expect(outcomeText(read)).not.toContain("Beta.");
  });

  it("keeps response commit all-or-nothing when the journal batch append fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
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
    const viewAfterFailure = await ctx.core.read({ file: "chapter.md" }, context);
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
});
