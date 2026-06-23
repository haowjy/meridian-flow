// Response-staging lifecycle and commit/rollback contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import { createUndoManagerRegistry } from "../undo/manager-registry.js";
import type { MutationCommit } from "./mutation-commit.js";
import { createResponseStaging } from "./response-staging.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import {
  blockTexts,
  expectOutcome,
  outcomeText,
  renderedBlockBodies,
} from "./test-support/assertions.js";
import { MemoryJournal } from "./test-support/recording-journal.js";
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
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
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

  it("preserves cross-document response staging order in the derived journal batch", async () => {
    const responseId = "response-cross-doc-order";
    const session: ActorSession = { id: "session-a", threadId: THREAD_ID, documents: new Map() };
    const runtimes = new Map<string, RuntimeDocumentState>();
    const journal = new MemoryJournal();
    const runtimeStore = {
      attachRuntime: () => {},
    } as unknown as RuntimeStore;
    const mutationCommit = {
      commitJournalBatch: async (entries: Parameters<MutationCommit["commitJournalBatch"]>[0]) => {
        await journal.appendBatch(entries);
      },
      projectToLive: async () => ({ ok: true, concurrent: { touchedHashes: new Set() } }),
    } as unknown as MutationCommit;
    const staging = createResponseStaging({
      registry: createUndoManagerRegistry(),
      runtimeStore,
      mutationCommit,
    });

    const stage = (docId: string, turnId: string) => {
      let runtime = runtimes.get(docId);
      if (!runtime) {
        runtime = {
          doc: new Y.Doc({ gc: false }),
          session,
          threadId: THREAD_ID,
          turnCounter: 0,
          undoStack: [],
          redoStack: [],
          redoStackRehydrated: false,
        };
        runtimes.set(docId, runtime);
      }
      staging.stageUpdate({
        responseId,
        docId,
        session,
        runtime,
        commandName: "insert",
        update: new Uint8Array([1, 2, 3]),
        meta: { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 },
        liveOrigin: { type: "agent", actorTurnId: turnId },
        turnId,
      });
    };

    stage("alpha.md", "turn-alpha-1");
    stage("beta.md", "turn-beta-1");
    stage("alpha.md", "turn-alpha-2");
    stage("beta.md", "turn-beta-2");

    const commit = await staging.commitResponse(responseId);

    expect(commit).toMatchObject({
      responseId,
      documentCount: 2,
      updateCount: 4,
      documents: [
        { documentId: "alpha.md", updateCount: 2 },
        { documentId: "beta.md", updateCount: 2 },
      ],
    });
    expect(journal.recordedBatches()).toEqual([
      [
        "alpha.md:turn-alpha-1",
        "beta.md:turn-beta-1",
        "alpha.md:turn-alpha-2",
        "beta.md:turn-beta-2",
      ],
    ]);
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
    expect(outcomeText(redo)).toContain("status: reversed");
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
      undoTurnId: "turn-multi-doc-response",
    });
    expect(await ctx.core.getAvailability("beta.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-multi-doc-response",
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
