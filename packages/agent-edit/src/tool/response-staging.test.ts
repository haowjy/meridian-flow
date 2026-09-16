// Response-staging lifecycle and commit/rollback contracts.
import { describe, expect, it, vi } from "vitest";

import {
  blockTexts,
  expectOutcome,
  humanText,
  outcomeText,
  renderedBlockBodies,
} from "./test-support/assertions.js";
import { context, harness, model, THREAD_ID } from "./test-support/write-tool-harness.js";

describe("response staging", () => {
  it("does not retain a staged write when echo summarization fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-echo-summary-failure";
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    expect(outcomeText(await ctx.core.write({ command: "read", file: "new.md" }, context))).toBe(
      'status: document_not_found\n\nFile not found. Check the path, or use write(command="create", file="new.md") to make a new one.',
    );
  });

  it("rejects writes staged against committed response ids with a typed tool error", async () => {
    const lifecycleErrors: unknown[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseLifecycleError: (event) => lifecycleErrors.push(event) },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    ).toContain("status: reconciled");
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
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

    const review = await ctx.core.write({ command: "read", file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha waits.", "Human waits."]);
  });

  it("drops staged response buffers when invalidating a thread", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    const read = await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("|Alpha.");
    expect(outcomeText(read)).not.toContain("Beta.");
  });

  it("rolls back staged response writes and restores the runtime doc from live", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    const read = await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("Alpha.");
    expect(outcomeText(read)).not.toContain("Beta.");
  });

  it("keeps response commit all-or-nothing when the journal batch append fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    const viewAfterFailure = await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
