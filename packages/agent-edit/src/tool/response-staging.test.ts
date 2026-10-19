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

describe("response staging", () => {
  it("retains an accepted staged write when echo summarization fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-echo-summary-failure";
    await ctx.core.read({ file: "chapter.md" }, context);
    const originalSerialize = model.serializeBlockLines.bind(model);
    const serialize = vi.spyOn(model, "serializeBlockLines").mockImplementation((doc, ...args) => {
      if (model.getBlocks(doc).some((block) => model.getText(block) === "Must persist.")) {
        throw new Error("echo summary failed");
      }
      return originalSerialize(doc, ...args);
    });

    const result = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Must persist." },
      {
        ...context,
        turnId: "turn-echo-summary-failure",
        responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
      },
    );
    serialize.mockRestore();

    expect(result).toMatchObject({
      status: "success",
      isError: false,
      result: { awarenessDegraded: true },
    });
    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      documentCount: 1,
      updateCount: 1,
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Must persist."]);
  });

  it("rolls back staged create without leaving an empty live document", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create-rollback",
      responseIdentity: {
        providerResponseId: "response-staged-create-rollback",
        editScopeId: "response-staged-create-rollback",
      },
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

  it("stages multiple response writes and commits journal plus live doc once", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-response-staging",
      responseIdentity: { providerResponseId: "response-staging", editScopeId: "response-staging" },
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

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Epsilon." },
      {
        ...context,
        turnId: "turn-response-staging-next",
        responseIdentity: {
          providerResponseId: "response-staging-next",
          editScopeId: "response-staging-next",
        },
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
      responseIdentity: {
        providerResponseId: "response-staged-read-resync-other-block",
        editScopeId: "response-staged-read-resync-other-block",
      },
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
      responseIdentity: {
        providerResponseId: "response-same-block",
        editScopeId: "response-same-block",
      },
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
      responseIdentity: {
        providerResponseId: "response-own-removal",
        editScopeId: "response-own-removal",
      },
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
      responseIdentity: {
        providerResponseId: "response-undo-mid",
        editScopeId: "response-undo-mid",
      },
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

  it("drops staged response buffers when invalidating a thread", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      {
        ...context,
        turnId: "turn-stale-buffer",
        responseIdentity: {
          providerResponseId: "response-stale-buffer",
          editScopeId: "response-stale-buffer",
        },
      },
    );

    ctx.core.dropStaged("chapter.md", THREAD_ID);
    await expect(ctx.core.commitResponse("response-stale-buffer")).rejects.toThrow(
      "already rolled back",
    );
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const read = await ctx.core.read({ file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("|Alpha.");
    expect(outcomeText(read)).not.toContain("Beta.");
  });

  it("keeps response commit all-or-nothing when the journal batch append fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.read({ file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-response-journal-fail",
      responseIdentity: {
        providerResponseId: "response-journal-fail",
        editScopeId: "response-journal-fail",
      },
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

it("keeps segmented writes logical across rollback, retry and live destinations", async () => {
  const ctx = harness({ "chapter.md": "She did what she wanted.\n\nShe climbed the road." }, {});
  const command = {
    command: "replace" as const,
    file: "chapter.md",
    in: [1, 2] as [number, number],
    content: "I do what I wanted.\n\nI climb the road.",
  };
  const staged = {
    ...context,
    turnId: "pov",
    responseIdentity: { providerResponseId: "abort", editScopeId: "abort" },
  };
  expect((await ctx.core.write(command, staged)).result.status).toBe("success");
  await ctx.core.rollbackResponse("abort");
  expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
  expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
    "She did what she wanted.",
    "She climbed the road.",
  ]);
  expect(
    (
      await ctx.core.write(command, {
        ...staged,
        responseIdentity: { providerResponseId: "retry", editScopeId: "retry" },
      })
    ).result.status,
  ).toBe("success");
  const committed = await ctx.core.commitResponse("retry");
  expect(committed.documents[0].receipts).toHaveLength(1);
  const entries = ctx.journal.recordedBatchEntries().at(-1) ?? [];
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map((entry) => entry.mutation?.writeId)).size).toBe(1);
  expect(new Set(entries.map((entry) => entry.mutation?.wId)).size).toBe(1);
  const live = harness({ "chapter.md": "She did what she wanted.\n\nShe climbed the road." });
  expect((await live.core.write(command, context)).result.status).toBe("success");
  expect((await live.journal.read("chapter.md")).updates).toHaveLength(2);
});
