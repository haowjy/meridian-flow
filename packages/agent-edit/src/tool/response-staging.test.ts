// Response-staging lifecycle and commit/rollback contracts.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  blockTexts,
  expectOutcome,
  hashAt,
  humanText,
  outcomeText,
  renderedBlockBodies,
} from "./test-support/assertions.js";
import { responseStagingHarness } from "./test-support/response-staging-harness.js";
import { context, harness, model, THREAD_ID } from "./test-support/write-tool-harness.js";

describe("response staging", () => {
  it("rejects a staged create overwrite using its pre-write baseline", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nWriter: Beta.\n\nGamma." });
    const responseId = "response-staged-create-overwrite";
    const writerHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    ctx.coordinator.concurrentUpdatesSince = async ({ baselineDoc }) =>
      baselineDoc && blockTexts(baselineDoc).includes("Writer: Beta.")
        ? [
            {
              update: new Uint8Array(),
              origin: { type: "human", userId: "human-1" },
              touchedHashes: { human: [writerHash] },
            },
          ]
        : [];

    const staged = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "Replacement.",
        overwrite: true,
        tool_use_id: "call-overwrite",
      },
      {
        ...context,
        responseId,
        turnId: "turn-staged-create-overwrite",
        createdDocument: false,
      },
    );
    expectOutcome(staged, "success");

    const result = await ctx.core.commitResponse(responseId);

    expect(result).toMatchObject({
      status: "rejected",
      rejections: [{ documentId: "chapter.md", affectedWriteIds: ["call-overwrite"] }],
    });
    expect(ctx.journal.recordedBatches()).toEqual([]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Writer: Beta.", "Gamma."]);
  });

  it("reports a phase-C sweep for staged create overwrite from its pre-own baseline", async () => {
    let ctx!: ReturnType<typeof harness>;
    const responseId = "response-staged-create-overwrite-late-sweep";
    ctx = harness(
      { "chapter.md": "Alpha.\n\nBeta." },
      {
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId === responseId) {
            humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 0 }, "Writer: ");
          }
        },
      },
    );
    const deletedHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const staged = await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "Replacement.",
        overwrite: true,
      },
      {
        ...context,
        responseId,
        turnId: "turn-staged-create-overwrite-late-sweep",
        createdDocument: false,
      },
    );
    expectOutcome(staged, "success");

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        {
          lateSweep: {
            affectedBlockHashes: expect.arrayContaining([deletedHash]),
            capturedDeletedBodies: expect.arrayContaining([
              { hash: deletedHash, body: "Writer: Beta." },
            ]),
          },
        },
      ],
    });
  });

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

  it("keeps delete-only buffered updates in the response-aware baseline", async () => {
    const ctx = harness({ "chapter.md": "Alpha doomed.\n\nBeta target.\n\nGamma human." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha doomed.", content: "" },
      {
        ...context,
        turnId: "turn-staged-delete-only-integrable",
        responseId: "response-staged-delete-only-integrable",
      },
    );

    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 0 }, "Human prefix. ");

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Beta target.",
        content: "Beta replacement.",
      },
      {
        ...context,
        turnId: "turn-staged-delete-only-integrable",
        responseId: "response-staged-delete-only-integrable",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    const text = outcomeText(result);
    expect(text).toContain("concurrent edits:");
    expect(text).toContain("Human prefix. Beta replacement.");
    expect(text).toContain("Gamma human.");
    expect(text).not.toMatch(/^ {4}[0-9a-f]{4}\|Alpha doomed\.$/m);
  });
  it("does not attribute a staged own replacement to human when using the default coordinator fallback", async () => {
    const ctx = harness({ "chapter.md": "Alpha target.\n\nBeta target." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));

    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 0 }, "Human prefix. ");

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Agent staged replacement.",
      },
      {
        ...context,
        turnId: "turn-staged-default-fallback-own-clean",
        responseId: "response-staged-default-fallback-own-clean",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    const text = outcomeText(result);
    expect(text).toContain("concurrent edits:");
    expect(text).toContain("Human prefix. Beta target.");
    expect(text).not.toMatch(/^ {4}[0-9a-f]{4}\|Agent staged replacement\.$/m);
  });

  it("renders concurrent edits from a pre-pull watermark on the staged write path", async () => {
    const ctx = harness({ "chapter.md": "Alpha line.\n\nTarget line." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));

    humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human prefix. ");

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Target line.",
        content: "Agent replacement.",
      },
      {
        ...context,
        turnId: "turn-staged-watermark",
        responseId: "response-staged-watermark",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    const text = outcomeText(result);
    expect(text).toContain("concurrent edits:");
    expect(text).toContain("human:");
    expect(text).toMatch(/^[0-9a-f]{4}\|Human prefix\. Alpha line\.$/m);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
  });

  it("dedupes same-block concurrent content already shown by the write echo", async () => {
    const ctx = harness({ "chapter.md": "Start target." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));

    humanText(
      ctx.liveDoc("chapter.md"),
      0,
      { from: "Start target.".length, to: "Start target.".length },
      " same-block-human",
    );

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "target",
        content: "agent",
      },
      {
        ...context,
        turnId: "turn-staged-same-block-render",
        responseId: "response-staged-same-block-render",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    const text = outcomeText(result);
    expect(text).toContain("concurrent edits:");
    expect(text).toMatch(/^[0-9a-f]{4}\|Start agent\. same-block-human$/m);
    expect(text.match(/same-block-human/g)).toHaveLength(1);
  });

  it("does not report earlier same-response staged writes as pulled concurrent edits", async () => {
    const ctx = harness({ "chapter.md": "Alpha line.\n\nFirst target.\n\nSecond target." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "First target.",
        content: "First staged.",
      },
      {
        ...context,
        turnId: "turn-staged-self-echo",
        responseId: "response-staged-self-echo",
      },
    );
    const stagedHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human prefix. ");

    const result = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Second target.",
        content: "Second staged.",
      },
      {
        ...context,
        turnId: "turn-staged-self-echo",
        responseId: "response-staged-self-echo",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    expect(outcomeText(result)).toContain("concurrent edits:");
    expect(outcomeText(result)).not.toContain(`human: ${stagedHash}`);
  });

  it("does not attribute a staged delete of a post-baseline human insert to the next human update", async () => {
    const ctx = harness({ "chapter.md": "Alpha target.\n\nBeta target." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    humanText(ctx.liveDoc("chapter.md"), 1, { from: "Beta".length, to: "Beta".length }, " human");

    const deleteHuman = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Beta human target.",
        content: "Beta target.",
      },
      {
        ...context,
        turnId: "turn-staged-delete-post-baseline-human",
        responseId: "response-staged-delete-post-baseline-human",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );
    expectOutcome(deleteHuman, "success");

    const next = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Alpha agent.",
      },
      {
        ...context,
        turnId: "turn-staged-delete-post-baseline-human",
        responseId: "response-staged-delete-post-baseline-human",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );

    const text = outcomeText(next);
    expectOutcome(next, "success");
    expect(text).not.toContain("human:");
    expect(text).not.toContain("Beta human target.");
  });

  it("keeps a benign staged edit after a baseline-covered human deletion writable", async () => {
    const ctx = harness({ "chapter.md": "Alpha target.\n\nBeta target." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: "Beta ".length }, "");
    const afterHumanDeletion = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));

    const first = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Alpha agent.",
      },
      {
        ...context,
        turnId: "turn-benign-covered-delete-set",
        responseId: "response-benign-covered-delete-set",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: afterHumanDeletion,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );
    expectOutcome(first, "success");

    const second = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "target.",
        content: "agent target.",
      },
      {
        ...context,
        turnId: "turn-benign-covered-delete-set",
        responseId: "response-benign-covered-delete-set",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: afterHumanDeletion,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );
    expectOutcome(second, "success");
  });

  it("degrades to a richer baseline instead of wedging a three-write staged response", async () => {
    const degraded: unknown[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha target.\n\nBeta target.\n\nGamma target." },
      { onBaselineDegraded: (event) => degraded.push(event) },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const beforePull = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    humanText(ctx.liveDoc("chapter.md"), 1, { from: "Beta".length, to: "Beta".length }, " human");

    const first = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Beta human target.",
        content: "Beta target.",
      },
      {
        ...context,
        turnId: "turn-staged-degrade",
        responseId: "response-staged-degrade",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );
    expectOutcome(first, "success");

    const second = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Alpha target.",
        content: "Alpha staged two.",
      },
      {
        ...context,
        turnId: "turn-staged-degrade",
        responseId: "response-staged-degrade",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
      },
    );
    expectOutcome(second, "success");

    const third = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        find: "Gamma target.",
        content: "Gamma staged three.",
      },
      {
        ...context,
        turnId: "turn-staged-degrade",
        responseId: "response-staged-degrade",
        interactionContext: {
          mode: "threadPeer",
          baselineSnapshot: beforePull,
          afterJournalId: 0,
          branchGeneration: 1,
        },
        tool_use_id: "tool-use-degrade-third",
      },
    );

    expectOutcome(third, "success");
    expect(degraded).toContainEqual(
      expect.objectContaining({
        documentId: "chapter.md",
        responseId: "response-staged-degrade",
        from: "interaction",
        to: "preOwnSnapshot",
      }),
    );
  });

  it("stages create and commits it through the response batch path", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create",
      responseId: "response-staged-create",
      createdDocument: true,
    };

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      responseContext,
    );

    expect(outcomeText(result)).toContain("status: success");
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(0);
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);

    const commit = await ctx.core.commitResponse("response-staged-create");
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.stagedCreates).toEqual({ committed: ["new.md"], discarded: [] });
    expect(ctx.journal.recordedBatches()).toEqual([["new.md:turn-staged-create"]]);
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
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

  it("reports a staged create as discarded when invalidation drops its response buffer", async () => {
    const ctx = harness();
    const responseContext = {
      ...context,
      turnId: "turn-staged-create-invalidated",
      responseId: "response-staged-create-invalidated",
      createdDocument: true,
    };

    await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      responseContext,
    );
    await ctx.core.invalidateThread("new.md", THREAD_ID);

    const commit = await ctx.core.commitResponse("response-staged-create-invalidated");

    expect(commit).toMatchObject({
      documentCount: 0,
      updateCount: 0,
      stagedCreates: { committed: [], discarded: ["new.md"] },
    });
    expect((await ctx.journal.read("new.md")).updates).toHaveLength(0);
    expect(ctx.coordinator.docs.has("new.md")).toBe(false);
    await expect(ctx.core.commitResponse("response-staged-create-invalidated")).rejects.toThrow(
      "already committed",
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

  it("preserves cross-document response staging order in the derived journal batch", async () => {
    const responseId = "response-cross-doc-order";
    const staging = await responseStagingHarness(responseId);

    const first = await staging.stageInsert("alpha.md", "Alpha one.", "turn-alpha-1");
    const second = await staging.stageInsert("beta.md", "Beta one.", "turn-beta-1");
    const third = await staging.stageInsert("alpha.md", "Alpha two.", "turn-alpha-2");
    const fourth = await staging.stageInsert("beta.md", "Beta two.", "turn-beta-2");

    expect([first.writeId, second.writeId, third.writeId, fourth.writeId]).toEqual([
      "w1",
      "w1",
      "w2",
      "w2",
    ]);
    expect(staging.recordedBatches()).toEqual([]);

    const commit = await staging.commit();

    expect(commit).toMatchObject({
      responseId,
      documentCount: 2,
      updateCount: 4,
      documents: [
        { documentId: "alpha.md", updateCount: 2 },
        { documentId: "beta.md", updateCount: 2 },
      ],
    });
    expect(staging.recordedBatches()).toEqual([
      [
        "alpha.md:turn-alpha-1",
        "beta.md:turn-beta-1",
        "alpha.md:turn-alpha-2",
        "beta.md:turn-beta-2",
      ],
    ]);
    expect(await staging.updateSeqs("alpha.md")).toEqual([1, 2]);
    expect(await staging.updateSeqs("beta.md")).toEqual([1, 2]);
  });

  it("returns cumulative staged echoes for text writes at the tool-response level", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

  it("resyncs staged response views from live while preserving staged edits on the same block", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-read-resync-same-block",
      responseId: "response-staged-read-resync-same-block",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 12, to: 17 }, "marches");

    const review = await ctx.core.write({ command: "read", file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent sword marches."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword marches."]);
  });

  it("detects concurrent edits that a staged read already absorbed into the runtime", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const blockHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    const responseContext = {
      ...context,
      turnId: "turn-staged-read-absorbed-concurrent",
      responseId: "response-staged-read-absorbed-concurrent",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 6, to: 11 }, "blade");

    const review = await ctx.core.write({ command: "read", file: "chapter.md" }, responseContext);
    expect(renderedBlockBodies(review)).toEqual(["Agent blade waits."]);

    const commit = await ctx.core.commitResponse("response-staged-read-absorbed-concurrent");
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.documents[0]?.concurrentEdits).toEqual(
      expect.objectContaining({ human: [blockHash], agent: [] }),
    );
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Agent blade waits."]);
  });

  it("rebuilds staged response views from canonical plus pending updates and drops runtime drift", async () => {
    const runtimeDocs: Y.Doc[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha waits.\n\nBravo waits." },
      {
        createRuntimeDoc: () => {
          const doc = new Y.Doc({ gc: false });
          runtimeDocs.push(doc);
          return doc;
        },
      },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-read-self-heals",
      responseId: "response-staged-read-self-heals",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 5 }, "Human");
    const driftedRuntime = currentRuntimeDoc(runtimeDocs);
    humanText(driftedRuntime, 0, { from: 6, to: 11 }, "drifts");

    const review = await ctx.core.write({ command: "read", file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(currentRuntimeDoc(runtimeDocs))).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha waits.", "Human waits."]);
  });

  it("reports concurrent edits at staged commit without recomputing write echoes", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nSpacer one.\n\nWho-\n\nSpacer two.\n\nClean." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const overlapHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const responseContext = {
      ...context,
      turnId: "turn-staged-per-write-overlap",
      responseId: "response-staged-per-write-overlap",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Beta" },
      responseContext,
    );
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Who-", content: "Who—" },
      responseContext,
    );
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Clean", content: "Done" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 2, { from: 3, to: 4 }, "---");

    const commit = await ctx.core.commitResponse("response-staged-per-write-overlap");
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.documents[0]?.concurrentEdits).toEqual(
      expect.objectContaining({ human: [overlapHash], agent: [] }),
    );
  });

  it("reports staged commit concurrent edits without post-commit echo recomputation", async () => {
    const ctx = harness({
      "chapter.md":
        "sword zero.\n\nGap one.\n\nBefore overlap.\n\nsword overlap.\n\nAfter overlap.\n\nGap two.\n\nsword far.",
    });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const expectedEchoHashes = [
      hashAt(ctx.liveDoc("chapter.md"), 2),
      hashAt(ctx.liveDoc("chapter.md"), 3),
      hashAt(ctx.liveDoc("chapter.md"), 4),
    ];
    const overlapHash = expectedEchoHashes[1];
    const farHashes = [hashAt(ctx.liveDoc("chapter.md"), 0), hashAt(ctx.liveDoc("chapter.md"), 6)];
    const responseContext = {
      ...context,
      turnId: "turn-staged-replace-all-windowed-overlap",
      responseId: "response-staged-replace-all-windowed-overlap",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", all: true, content: "blade" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 3, { from: 6, to: 13 }, "human");

    const commit = await ctx.core.commitResponse("response-staged-replace-all-windowed-overlap");
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.documents[0]?.concurrentEdits).toEqual(
      expect.objectContaining({ human: [overlapHash], agent: [] }),
    );
    expect(commit.documents[0]).toEqual({
      documentId: "chapter.md",
      updateCount: 1,
      concurrentEdits: expect.objectContaining({ human: [overlapHash], agent: [] }),
    });
    void expectedEchoHashes;
    void farHashes;
  });

  it("suppresses all post-commit output for no-concurrent non-structural staged writes", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-suppressed-commit",
      responseId: "response-staged-suppressed-commit",
    };

    const first = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Beta" },
      responseContext,
    );
    const second = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      responseContext,
    );

    expect(outcomeText(first)).toContain("write id: w1");
    expect(outcomeText(second)).toContain("write id: w2");

    const commit = await ctx.core.commitResponse("response-staged-suppressed-commit");
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.documents[0]?.concurrentEdits).toBeUndefined();
    expect(commit.documents[0]).toEqual({ documentId: "chapter.md", updateCount: 2 });
  });

  it("returns a model-facing concurrent-edit echo when a staged commit merges a human edit", async () => {
    const ctx = harness({ "chapter.md": "Who-" });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const blockHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Who-", content: "Who—" },
      { ...context, turnId: "turn-staged-concurrent", responseId: "response-staged-concurrent" },
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 3, to: 4 }, "---");

    const commit = await ctx.core.commitResponse("response-staged-concurrent");
    if (commit.status !== "committed") throw new Error("expected committed response");

    expect(commit.documents).toHaveLength(1);
    expect(commit.documents[0]).toMatchObject({
      documentId: "chapter.md",
      updateCount: 1,
      concurrentEdits: expect.objectContaining({ human: [blockHash], agent: [] }),
    });
  });

  it("re-grounds the runtime after staged commit so the next read includes merged live edits", async () => {
    const ctx = harness({ "chapter.md": "Who-" });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Who-", content: "Who—" },
      { ...context, turnId: "turn-staged-reground", responseId: "response-staged-reground" },
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 3, to: 4 }, "---");
    await ctx.core.commitResponse("response-staged-reground");

    const read = await ctx.core.write({ command: "read", file: "chapter.md" }, context);

    expect(outcomeText(read)).toContain("---");
    expect(outcomeText(read)).not.toBe("status: success\n\nWho—");
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

  it("keeps a post-journal response as the next undo target after live recovery", async () => {
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(
      { "chapter.md": "Alpha." },
      {
        afterResponsePreflight: (responseId) => {
          if (responseId === "response-live-fail") {
            ctx.coordinator.failNextWith(new Error("live merge unavailable"));
          }
        },
      },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    expect(outcomeText(redo)).toContain("status: reconciled");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta.", "Gamma."]);
  });

  it("recovers all documents when a multi-document response fails during the second live merge", async () => {
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(
      { "alpha.md": "Alpha.", "beta.md": "One." },
      {
        afterResponsePreflight: (responseId) => {
          if (responseId === "response-multi-doc-live-fail") {
            ctx.coordinator.failNextForDoc("beta.md", new Error("second live merge unavailable"));
          }
        },
      },
    );
    await ctx.core.write({ command: "read", file: "alpha.md" }, context);
    await ctx.core.write({ command: "read", file: "beta.md" }, context);
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

    await expect(ctx.core.commitResponse("response-multi-doc-live-fail")).resolves.toMatchObject({
      responseId: "response-multi-doc-live-fail",
      documentCount: 2,
      updateCount: 2,
      documents: [
        { documentId: "alpha.md", updateCount: 1 },
        { documentId: "beta.md", updateCount: 1 },
      ],
    });

    expect(ctx.journal.recordedBatches()).toEqual([
      ["alpha.md:turn-multi-doc-response", "beta.md:turn-multi-doc-response"],
    ]);
    expect((await ctx.journal.read("alpha.md")).updates).toHaveLength(1);
    expect((await ctx.journal.read("beta.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha.", "Beta."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["One.", "Two."]);
    expect(await ctx.core.getAvailability("alpha.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w1",
    });
    expect(await ctx.core.getAvailability("beta.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w1",
    });

    const freshContext = { ...context, sessionId: "fresh-session" };
    expect(
      renderedBlockBodies(
        await ctx.core.write({ command: "read", file: "alpha.md" }, freshContext),
      ),
    ).toEqual(["Alpha.", "Beta."]);
    expect(
      renderedBlockBodies(await ctx.core.write({ command: "read", file: "beta.md" }, freshContext)),
    ).toEqual(["One.", "Two."]);
    const recoveredUndo = await ctx.core.reverse({
      docId: "alpha.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor: { type: "agent" },
      interactionContext: {
        mode: "live",
        baselineSnapshot: Y.encodeStateAsUpdate(ctx.liveDoc("alpha.md")),
      },
    });
    expect(outcomeText(recoveredUndo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha."]);
    await expect(ctx.core.commitResponse("response-multi-doc-live-fail")).rejects.toThrow(
      "already committed",
    );
  });

  it("closes rollback as degraded and releases the buffer when runtime restoration fails", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

    await expect(ctx.core.rollbackResponse("response-rollback-fail")).resolves.toMatchObject({
      status: "rolledBackDegraded",
      restorationFailed: true,
    });

    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(0);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
    const read = await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    expect(outcomeText(read)).toContain("Alpha.");
    expect(outcomeText(read)).not.toContain("Beta.");
    await expect(ctx.core.commitResponse("response-rollback-fail")).rejects.toThrow(
      "already rolled back",
    );
  });

  it("commits doc B and records a loud claimed discard when doc A is dropped mid-response", async () => {
    const events: { code: string; documents: unknown[]; responseId: string }[] = [];
    const ctx = harness(
      { "alpha.md": "Alpha.", "beta.md": "Beta." },
      {
        onResponseClaimDiscarded: (event) => {
          events.push({
            code: event.code,
            documents: [...event.documents],
            responseId: event.responseId,
          });
        },
      },
    );
    await ctx.core.write({ command: "read", file: "alpha.md" }, context);
    await ctx.core.write({ command: "read", file: "beta.md" }, context);
    const responseId = "response-partial-drop";
    const responseContext = {
      ...context,
      turnId: "turn-partial-drop",
      responseId,
    };
    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "Tail." },
      responseContext,
    );
    await ctx.core.write({ command: "insert", file: "beta.md", content: "Tail." }, responseContext);

    // Writer-discards doc A's card while the response is still open with doc B staged.
    await ctx.core.invalidateThread("alpha.md", THREAD_ID);

    const result = await ctx.core.commitResponse(responseId);
    if (result.status !== "committed") throw new Error("expected committed response");

    expect(result.documentCount).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].documentId).toBe("beta.md");
    expect(result.updateCount).toBe(1);
    expect(result.discardedClaims).toBeDefined();
    expect(result.discardedClaims).toHaveLength(1);
    expect(result.discardedClaims?.[0]).toMatchObject({
      documentId: "alpha.md",
      threadId: THREAD_ID,
    });
    expect(result.discardedClaims?.[0]?.updateCount).toBeGreaterThanOrEqual(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: "claimed_write_discarded",
      responseId,
      documents: [{ documentId: "alpha.md", threadId: THREAD_ID }],
    });

    expect((await ctx.journal.read("alpha.md")).updates).toHaveLength(0);
    expect((await ctx.journal.read("beta.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["Beta.", "Tail."]);
  });

  it("collapses repeated discards for the same (doc, thread) claim into one loud summary", async () => {
    const events: { code: string; documents: unknown[]; responseId: string }[] = [];
    const ctx = harness(
      { "alpha.md": "Alpha.", "beta.md": "Beta." },
      {
        onResponseClaimDiscarded: (event) => {
          events.push({
            code: event.code,
            documents: [...event.documents],
            responseId: event.responseId,
          });
        },
      },
    );
    await ctx.core.write({ command: "read", file: "alpha.md" }, context);
    await ctx.core.write({ command: "read", file: "beta.md" }, context);
    const responseId = "response-partial-drop-collapsed";
    const responseContext = {
      ...context,
      turnId: "turn-partial-drop-collapsed",
      responseId,
    };
    // Keep beta.md staged across all drops so the buffer stays open between
    // successive drops; only alpha.md gets re-staged and re-dropped.
    await ctx.core.write(
      { command: "insert", file: "beta.md", content: "Beta tail." },
      responseContext,
    );
    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "Tail one." },
      responseContext,
    );
    await ctx.core.invalidateThread("alpha.md", THREAD_ID);
    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "Tail two." },
      responseContext,
    );
    await ctx.core.invalidateThread("alpha.md", THREAD_ID);

    const result = await ctx.core.commitResponse(responseId);
    if (result.status !== "committed") throw new Error("expected committed response");

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].documentId).toBe("beta.md");
    expect(result.discardedClaims).toHaveLength(1);
    expect(result.discardedClaims?.[0]).toMatchObject({
      documentId: "alpha.md",
      threadId: THREAD_ID,
    });
    expect(result.discardedClaims?.[0]?.updateCount).toBe(2);
    expect(events).toHaveLength(1);
  });
});

function currentRuntimeDoc(runtimeDocs: readonly Y.Doc[]): Y.Doc {
  const runtime = runtimeDocs.at(-1);
  if (!runtime) throw new Error("Expected a runtime document to exist");
  return runtime;
}
