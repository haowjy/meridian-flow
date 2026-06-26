// Response-staging lifecycle and commit/rollback contracts.
import { describe, expect, it } from "vitest";
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
import { context, harness, THREAD_ID } from "./test-support/write-tool-harness.js";

describe("response staging", () => {
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

  it("resyncs staged response views from live while preserving staged edits on another block", async () => {
    const ctx = harness({ "chapter.md": "Alpha waits.\n\nBravo waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-view-resync-other-block",
      responseId: "response-staged-view-resync-other-block",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 5 }, "Human");

    const review = await ctx.core.write({ command: "view", file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha waits.", "Human waits."]);
  });

  it("resyncs staged response views from live while preserving staged edits on the same block", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-view-resync-same-block",
      responseId: "response-staged-view-resync-same-block",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 12, to: 17 }, "marches");

    const review = await ctx.core.write({ command: "view", file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent sword marches."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword marches."]);
  });

  it("detects concurrent edits that a staged view already absorbed into the runtime", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const blockHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    const responseContext = {
      ...context,
      turnId: "turn-staged-view-absorbed-concurrent",
      responseId: "response-staged-view-absorbed-concurrent",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 6, to: 11 }, "blade");

    const review = await ctx.core.write({ command: "view", file: "chapter.md" }, responseContext);
    expect(renderedBlockBodies(review)).toEqual(["Agent blade waits."]);

    const commit = await ctx.core.commitResponse("response-staged-view-absorbed-concurrent");

    expect(commit.documents[0]?.concurrentEdits).toEqual({ human: [blockHash], agent: [] });
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
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const responseContext = {
      ...context,
      turnId: "turn-staged-view-self-heals",
      responseId: "response-staged-view-self-heals",
    };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha", content: "Agent" },
      responseContext,
    );
    humanText(ctx.liveDoc("chapter.md"), 1, { from: 0, to: 5 }, "Human");
    const driftedRuntime = currentRuntimeDoc(runtimeDocs);
    humanText(driftedRuntime, 0, { from: 6, to: 11 }, "drifts");

    const review = await ctx.core.write({ command: "view", file: "chapter.md" }, responseContext);

    expect(renderedBlockBodies(review)).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(currentRuntimeDoc(runtimeDocs))).toEqual(["Agent waits.", "Human waits."]);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha waits.", "Human waits."]);
  });

  it("reports concurrent edits at staged commit without recomputing write echoes", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nSpacer one.\n\nWho-\n\nSpacer two.\n\nClean." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
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

    expect(commit.documents[0]?.concurrentEdits).toEqual({ human: [overlapHash], agent: [] });
  });

  it("reports staged commit concurrent edits without post-commit echo recomputation", async () => {
    const ctx = harness({
      "chapter.md":
        "sword zero.\n\nGap one.\n\nBefore overlap.\n\nsword overlap.\n\nAfter overlap.\n\nGap two.\n\nsword far.",
    });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
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

    expect(commit.documents[0]?.concurrentEdits).toEqual({ human: [overlapHash], agent: [] });
    expect(commit.documents[0]).toEqual({
      documentId: "chapter.md",
      updateCount: 1,
      concurrentEdits: { human: [overlapHash], agent: [] },
    });
    void expectedEchoHashes;
    void farHashes;
  });

  it("suppresses all post-commit output for no-concurrent non-structural staged writes", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
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

    expect(commit.documents[0]?.concurrentEdits).toBeUndefined();
    expect(commit.documents[0]).toEqual({ documentId: "chapter.md", updateCount: 2 });
  });

  it("returns a model-facing concurrent-edit echo when a staged commit merges a human edit", async () => {
    const ctx = harness({ "chapter.md": "Who-" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const blockHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Who-", content: "Who—" },
      { ...context, turnId: "turn-staged-concurrent", responseId: "response-staged-concurrent" },
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 3, to: 4 }, "---");

    const commit = await ctx.core.commitResponse("response-staged-concurrent");

    expect(commit.documents).toHaveLength(1);
    expect(commit.documents[0]).toMatchObject({
      documentId: "chapter.md",
      updateCount: 1,
      concurrentEdits: { human: [blockHash], agent: [] },
    });
  });

  it("re-grounds the runtime after staged commit so the next view includes merged live edits", async () => {
    const ctx = harness({ "chapter.md": "Who-" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Who-", content: "Who—" },
      { ...context, turnId: "turn-staged-reground", responseId: "response-staged-reground" },
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 3, to: 4 }, "---");
    await ctx.core.commitResponse("response-staged-reground");

    const view = await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    expect(outcomeText(view)).toContain("---");
    expect(outcomeText(view)).not.toBe("status: success\n\nWho—");
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
    expect(outcomeText(redo)).toContain("status: reconciled");
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
        await ctx.core.write({ command: "view", file: "alpha.md" }, freshContext),
      ),
    ).toEqual(["Alpha.", "Beta."]);
    expect(
      renderedBlockBodies(await ctx.core.write({ command: "view", file: "beta.md" }, freshContext)),
    ).toEqual(["One.", "Two."]);
    const recoveredUndo = await ctx.core.undoTurn("alpha.md", THREAD_ID);
    expect(outcomeText(recoveredUndo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha."]);
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
});

function currentRuntimeDoc(runtimeDocs: readonly Y.Doc[]): Y.Doc {
  const runtime = runtimeDocs.at(-1);
  if (!runtime) throw new Error("Expected a runtime document to exist");
  return runtime;
}
