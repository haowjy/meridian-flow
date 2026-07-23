// Response committer lifecycle invariants: observer failures must not alter outcomes.
import { describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import { toDocHandle } from "../handles.js";
import { digestRenderedContent } from "../observation-snapshot.js";
import type { ObservationSnapshot } from "../ports/observation-snapshot.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import { blockTexts, hashAt, humanText } from "./test-support/assertions.js";
import { codec, context, harness, model, THREAD_ID } from "./test-support/write-tool-harness.js";
import type { ResponseCommitterTransitionDetail } from "./types.js";

function emptyObservationStore() {
  return {
    async seal() {},
    async load(responseId: string): Promise<ObservationSnapshot> {
      return { responseId, entries: [] };
    },
  };
}

function observationSnapshot(responseId: string, doc: Y.Doc): ObservationSnapshot {
  return {
    responseId,
    entries: snapshotBlocks(toDocHandle(doc), model, codec).map((block) => ({
      documentId: "chapter.md",
      clientID: block.clientID as number,
      clock: block.clock as number,
      value: {
        kind: "rendered",
        digest: digestRenderedContent(block.renderedContent as string),
      },
    })),
  };
}

describe("response committer", () => {
  it("commits a blind agent overwrite of agent-only content without a sweep", async () => {
    const ctx = harness({}, { observationSnapshots: emptyObservationStore() });
    await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Agent-authored opening." },
      {
        ...context,
        responseId: "response-agent-a",
        turnId: "turn-agent-a",
        createdDocument: true,
      },
    );
    await ctx.core.commitResponse("response-agent-a");

    await stageBlindOverwrite(ctx, "response-agent-b", "Rewritten by the agent.");
    const result = await ctx.core.commitResponse("response-agent-b");

    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(result.documents[0]?.lateSweep).toBeUndefined();
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Rewritten by the agent."]);
  });

  it("commits a blind agent overwrite of writer content with a captured sweep", async () => {
    const ctx = harness({}, { observationSnapshots: emptyObservationStore() });
    await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Writer-authored opening." },
      { ...context, actor: { kind: "human", userId: "writer-1" } },
    );
    const writerHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    await stageBlindOverwrite(ctx, "response-writer", "Agent replacement.");
    const result = await ctx.core.commitResponse("response-writer");

    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(result.documents[0]?.lateSweep).toEqual({
      affectedBlockHashes: [writerHash],
      capturedDeletedBodies: [{ hash: writerHash, body: "Writer-authored opening." }],
      sweptContent: true,
      beforeContentRef: null,
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Agent replacement."]);
  });

  it("reports only writer lineage from a blind overwrite of mixed content", async () => {
    const ctx = harness({}, { observationSnapshots: emptyObservationStore() });
    await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Writer-authored opening." },
      { ...context, actor: { kind: "human", userId: "writer-1" } },
    );
    const writerHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Agent-authored continuation." },
      { ...context, responseId: "response-mixed-a", turnId: "turn-mixed-a" },
    );
    await ctx.core.commitResponse("response-mixed-a");

    await stageBlindOverwrite(ctx, "response-mixed-b", "Mixed replacement.");
    const result = await ctx.core.commitResponse("response-mixed-b");

    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(result.documents[0]?.lateSweep).toEqual({
      affectedBlockHashes: [writerHash],
      capturedDeletedBodies: [{ hash: writerHash, body: "Writer-authored opening." }],
      sweptContent: true,
      beforeContentRef: null,
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Mixed replacement."]);
  });

  it("commits a blind human overwrite without a sweep", async () => {
    const ctx = harness({}, { observationSnapshots: emptyObservationStore() });
    const actor = { kind: "human", userId: "writer-1" } as const;
    await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Writer opening." },
      { ...context, actor },
    );
    await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "Writer replacement.",
        overwrite: true,
      },
      { ...context, actor, responseId: "response-human", turnId: "turn-human" },
    );
    const result = await ctx.core.commitResponse("response-human");

    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(result.documents[0]?.lateSweep).toBeUndefined();
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Writer replacement."]);
  });

  it("S1: stays silent when the authoring response observed the current passage", async () => {
    const ctx = harness({ "chapter.md": "Observed passage.\n\nKeep." });
    const responseId = "response-s1-observed";
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Observed passage.", content: "" },
      { ...context, responseId, turnId: "turn-s1" },
    );

    const result = await ctx.core.commitResponse(responseId);

    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(result.documents[0]?.lateSweep).toBeUndefined();
    expect(blockTexts(ctx.liveDoc("chapter.md"))).not.toContain("Observed passage.");
  });

  it("commits a blind destructive response from the snapshot empty-case", async () => {
    const ctx = harness(
      { "chapter.md": "Unseen passage.\n\nKeep." },
      { observationSnapshots: emptyObservationStore() },
    );
    const responseId = "response-blind";
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Unseen passage.", content: "" },
      { ...context, responseId, turnId: "turn-blind" },
    );

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        {
          lateSweep: {
            affectedBlockHashes: expect.any(Array),
            capturedDeletedBodies: [
              expect.objectContaining({
                body: "Unseen passage.",
              }),
            ],
          },
        },
      ],
    });
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["", "Keep."]);
  });

  it("stays silent when a later response observed a prior response echo", async () => {
    const snapshots = new Map<string, ObservationSnapshot>();
    const ctx = harness(
      { "chapter.md": "Opening." },
      {
        observationSnapshots: {
          async seal(snapshot) {
            snapshots.set(snapshot.responseId, snapshot);
          },
          async load(responseId) {
            return snapshots.get(responseId) ?? null;
          },
        },
      },
    );
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Echoed passage." },
      { ...context, responseId: "response-prior", turnId: "turn-prior" },
    );
    await ctx.core.commitResponse("response-prior");
    snapshots.set(
      "response-after-echo",
      observationSnapshot("response-after-echo", ctx.liveDoc("chapter.md")),
    );

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Echoed passage.", content: "" },
      { ...context, responseId: "response-after-echo", turnId: "turn-after-echo" },
    );
    const result = await ctx.core.commitResponse("response-after-echo");

    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(result.documents[0]?.lateSweep).toBeUndefined();
  });
  it("defers lifecycle close and restores buffered ownership when the host transaction aborts", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
    );
    const responseId = "response-deferred-close";
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, responseId, turnId: "turn-deferred-close" },
    );
    let participant: { commit(): void | Promise<void>; abort(): void | Promise<void> } | undefined;

    await ctx.core.commitResponse(responseId, {
      deferFinalization: (deferred) => {
        participant = deferred;
      },
    });
    expect(transitions.some((event) => event.transition === "closed")).toBe(false);
    await participant?.abort();
    expect(ctx.core.bufferedUpdatesForDoc(responseId, "chapter.md")).toHaveLength(1);
  });

  it("publishes deferred lifecycle close only after the host commits", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
    );
    const responseId = "response-publish-close";
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, responseId, turnId: "turn-publish-close" },
    );
    let commit = async () => {};
    await ctx.core.commitResponse(responseId, {
      deferFinalization: (participant) => {
        commit = async () => participant.commit();
      },
    });
    expect(transitions.some((event) => event.transition === "closed")).toBe(false);
    await commit();
    expect(transitions.at(-1)).toMatchObject({
      transition: "closed",
      closedOutcome: "committed",
    });
  });

  it("reports process-local journal staging separately and restores buffered on failure", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => transitions.push(event),
        afterResponsePreflight: () => ctx.coordinator.failWith(new Error("phase C failed")),
      },
    );
    const appendBatch = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) =>
      (await appendBatch(entries)).map((entry) => ({ ...entry, journalCommitKind: "staged" }));
    const responseId = "response-journal-staged";
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, responseId, turnId: "turn-journal-staged" },
    );

    await expect(ctx.core.commitResponse(responseId)).rejects.toThrow("staged journal batch");
    expect(transitions.map((event) => event.transition)).toContain("journal_staged");
    expect(transitions.map((event) => event.transition)).not.toContain("journal_committed");
    expect(ctx.core.bufferedUpdatesForDoc(responseId, "chapter.md")).toHaveLength(1);
  });

  it("S2: reports text typed during the turn and keeps the merge", async () => {
    let ctx!: ReturnType<typeof harness>;
    const responseId = "response-late-sweep";
    ctx = harness(
      { "chapter.md": "Alpha.\n\nBeta.\n\nGamma." },
      {
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId === responseId) {
            humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Writer: ");
          }
        },
      },
    );
    const deletedHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Agent note." },
      {
        ...context,
        responseId,
        turnId: "turn-insert",
        interactionContext: { mode: "live" },
      },
    );
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.\n\nBeta.", content: "" },
      {
        ...context,
        responseId,
        turnId: "turn-delete",
        interactionContext: { mode: "live" },
      },
    );

    const result = await ctx.core.commitResponse(responseId);

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected committed response");
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect(result.documents[0]?.lateSweep).toEqual({
      affectedBlockHashes: [deletedHash],
      capturedDeletedBodies: [{ hash: deletedHash, body: "Writer: Alpha." }],
      sweptContent: true,
      beforeContentRef: null,
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Gamma.", "Agent note."]);
    await expect(
      ctx.core.write({ command: "insert", file: "chapter.md", content: "Next response." }, context),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("captures every affected body when one block changes and another is deleted during phase C", async () => {
    let ctx!: ReturnType<typeof harness>;
    const responseId = "response-mixed-late-sweep";
    ctx = harness(
      { "chapter.md": "Alpha.\n\nBeta.\n\nGamma." },
      {
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId !== responseId) return;
          const live = ctx.liveDoc("chapter.md");
          humanText(live, 0, { from: 0, to: 0 }, "WS: ");
          model.transact(
            toDocHandle(live),
            () => model.deleteBlock(toDocHandle(live), model.getBlocks(toDocHandle(live))[1]),
            { type: "human" },
          );
        },
      },
    );
    const affectedHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.\n\nBeta.", content: "" },
      {
        ...context,
        responseId,
        turnId: "turn-mixed-sweep",
        interactionContext: { mode: "live" },
      },
    );

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        {
          lateSweep: {
            affectedBlockHashes: [affectedHash],
            capturedDeletedBodies: [{ hash: affectedHash, body: "WS: Alpha." }],
          },
        },
      ],
    });
  });

  it("reports a late destructive sweep when phase C retries after a transient failure", async () => {
    let ctx!: ReturnType<typeof harness>;
    const responseId = "response-late-sweep-phase-c-retry";
    ctx = harness(
      { "chapter.md": "Alpha.\n\nBeta.\n\nGamma." },
      {
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId !== responseId) return;
          humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Writer: ");
          ctx.coordinator.failNextForDoc("chapter.md", new Error("phase C unavailable"));
        },
      },
    );
    const deletedHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.\n\nBeta.", content: "" },
      {
        ...context,
        responseId,
        turnId: "turn-phase-c-retry",
        interactionContext: { mode: "live" },
      },
    );

    const result = await ctx.core.commitResponse(responseId);

    expect(result).toMatchObject({
      status: "committed",
      documents: [
        {
          documentId: "chapter.md",
          lateSweep: {
            affectedBlockHashes: expect.arrayContaining([deletedHash]),
            capturedDeletedBodies: [{ hash: deletedHash, body: "Writer: Alpha." }],
            sweptContent: true,
          },
        },
      ],
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Gamma."]);
  });

  it("aborts after phase A without journaling and leaves the response retryable", async () => {
    const abort = new AbortController();
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { afterResponsePreflight: () => abort.abort() },
    );
    const responseId = "response-abort-between-a-and-b";
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, responseId, turnId: "turn-abort-between-a-and-b" },
    );

    await expect(ctx.core.commitResponse(responseId, { signal: abort.signal })).rejects.toThrow(
      "before the journal batch was committed",
    );
    expect(ctx.journal.recordedBatches()).toEqual([]);
  });

  it("commits a multi-document thread-peer response in one journal batch", async () => {
    const ctx = harness({ "alpha.md": "Alpha.", "beta.md": "Beta." });
    const responseId = "response-multi-thread-peer";
    await ctx.core.write({ command: "read", file: "alpha.md" }, context);
    await ctx.core.write({ command: "read", file: "beta.md" }, context);
    for (const file of ["alpha.md", "beta.md"]) {
      await ctx.core.write(
        { command: "insert", file, content: "Tail." },
        {
          ...context,
          responseId,
          turnId: `turn-${file}`,
          interactionContext: { mode: "threadPeer", branchGeneration: 1 },
        },
      );
    }

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documentCount: 2,
    });
    expect(ctx.journal.recordedBatches()).toEqual([
      ["alpha.md:turn-alpha.md", "beta.md:turn-beta.md"],
    ]);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha.", "Tail."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["Beta.", "Tail."]);
  });

  it("rechecks for a silent sweep after phase C and its retry both fail", async () => {
    let remainingPhaseCFailures = 0;
    let ctx!: ReturnType<typeof harness>;
    const responseId = "response-recovery-recheck";
    ctx = harness(
      { "chapter.md": "Alpha.\n\nBeta.\n\nGamma." },
      {
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId !== responseId) return;
          humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Writer: ");
          remainingPhaseCFailures = 2;
        },
      },
    );
    const originalWithDocument = ctx.coordinator.withDocument.bind(ctx.coordinator);
    ctx.coordinator.withDocument = async <T>(docId: string, fn: (doc: Y.Doc) => Promise<T>) => {
      if (remainingPhaseCFailures > 0) {
        remainingPhaseCFailures -= 1;
        throw new Error("phase C unavailable");
      }
      return originalWithDocument(docId, fn);
    };
    const deletedHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.\n\nBeta.", content: "" },
      {
        ...context,
        responseId,
        turnId: "turn-recovery-recheck",
        interactionContext: { mode: "live" },
      },
    );

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        {
          lateSweep: {
            affectedBlockHashes: expect.arrayContaining([deletedHash]),
            sweptContent: true,
          },
        },
      ],
    });
  });

  it("classifies a blind writer sweep after journal recovery", async () => {
    let remainingPhaseCFailures = 0;
    const responseId = "response-blind-recovery-sweep";
    const ctx = harness(
      { "chapter.md": "Writer body." },
      {
        observationSnapshots: emptyObservationStore(),
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId === responseId) remainingPhaseCFailures = 2;
        },
      },
    );
    const originalWithDocument = ctx.coordinator.withDocument.bind(ctx.coordinator);
    ctx.coordinator.withDocument = async <T>(docId: string, fn: (doc: Y.Doc) => Promise<T>) => {
      if (remainingPhaseCFailures > 0) {
        remainingPhaseCFailures -= 1;
        throw new Error("phase C unavailable");
      }
      return originalWithDocument(docId, fn);
    };
    const writerHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await ctx.core.write(
      {
        command: "create",
        file: "chapter.md",
        content: "Agent replacement.",
        overwrite: true,
      },
      {
        ...context,
        responseId,
        turnId: "turn-blind-recovery",
        createdDocument: false,
      },
    );

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documents: [
        {
          lateSweep: {
            affectedBlockHashes: [writerHash],
            capturedDeletedBodies: [{ hash: writerHash, body: "Writer body." }],
            sweptContent: true,
          },
        },
      ],
    });
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Agent replacement."]);
  });

  it("reports degraded awareness and invalidates every runtime when recovery recheck fails", async () => {
    let remainingPhaseCFailures = 0;
    let failConcurrentRecheck = false;
    let ctx!: ReturnType<typeof harness>;
    const responseId = "response-recovery-awareness-degraded";
    ctx = harness(
      { "alpha.md": "Alpha.\n\nDelete.", "beta.md": "Beta." },
      {
        afterResponsePreflight: (currentResponseId) => {
          if (currentResponseId === responseId) {
            remainingPhaseCFailures = 2;
            failConcurrentRecheck = true;
          }
        },
      },
    );
    const originalWithDocument = ctx.coordinator.withDocument.bind(ctx.coordinator);
    ctx.coordinator.withDocument = async <T>(docId: string, fn: (doc: Y.Doc) => Promise<T>) => {
      if (remainingPhaseCFailures > 0) {
        remainingPhaseCFailures -= 1;
        throw new Error("phase C unavailable");
      }
      return originalWithDocument(docId, fn);
    };
    ctx.coordinator.concurrentUpdatesSince = async () => {
      if (failConcurrentRecheck) throw new Error("concurrent state unavailable");
      return [];
    };
    for (const file of ["alpha.md", "beta.md"]) {
      await ctx.core.write({ command: "read", file }, context);
    }
    await ctx.core.write(
      { command: "replace", file: "alpha.md", find: "Alpha.\n\nDelete.", content: "" },
      { ...context, responseId, turnId: "turn-alpha-degraded" },
    );
    await ctx.core.write(
      { command: "insert", file: "beta.md", content: "Tail." },
      { ...context, responseId, turnId: "turn-beta-degraded" },
    );

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      awarenessDegraded: true,
      documentCount: 2,
    });
  });

  it("aborts a queued preflight before journaling and leaves the response retryable", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-aborted-preflight";
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, responseId, turnId: "turn-aborted-preflight" },
    );
    const originalWithDocument = ctx.coordinator.withDocument.bind(ctx.coordinator);
    ctx.coordinator.withDocument = () => new Promise<never>(() => {});
    const abort = new AbortController();
    const commit = ctx.core.commitResponse(responseId, { signal: abort.signal });
    abort.abort();

    await expect(commit).rejects.toThrow("before the journal batch was committed");
    expect(ctx.journal.recordedBatches()).toEqual([]);

    ctx.coordinator.withDocument = originalWithDocument;
    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      updateCount: 1,
    });
  });
  it("joins a second commit that arrives after the journal append", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-late-second-commit";
    const responseContext = { ...context, turnId: "turn-late-second-commit", responseId };
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const projected = deferred<void>();
    const releaseProjection = deferred<void>();
    let projectionCount = 0;
    const originalWithDocument = ctx.coordinator.withDocument.bind(ctx.coordinator);
    ctx.coordinator.withDocument = async (docId, fn) => {
      projectionCount += 1;
      projected.resolve();
      await releaseProjection.promise;
      return originalWithDocument(docId, fn);
    };

    const first = ctx.core.commitResponse(responseId);
    await projected.promise;
    const second = ctx.core.commitResponse(responseId);
    releaseProjection.resolve();
    expect(await Promise.all([first, second])).toEqual([await first, await first]);
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect(projectionCount).toBe(2);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("closes a durable response when projection and recovery both fail", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => transitions.push(event),
        afterResponsePreflight: () => ctx.coordinator.failWith(new Error("projection failed")),
      },
    );
    const responseId = "response-durable-projection-recovery-failure";
    const responseContext = {
      ...context,
      turnId: "turn-durable-projection-recovery-failure",
      responseId,
    };
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Durable words." },
      responseContext,
    );

    const originalRecover = ctx.coordinator.recover.bind(ctx.coordinator);
    const recover = vi
      .spyOn(ctx.coordinator, "recover")
      .mockRejectedValueOnce(new Error("recovery failed"));

    await expect(ctx.core.commitResponse(responseId)).rejects.toThrow("projection failed");
    expect(transitions.at(-1)).toMatchObject({
      transition: "closed",
      closedOutcome: "committed",
      journalCommitKind: "durable",
    });
    await expect(ctx.core.commitResponse(responseId)).rejects.toThrow("already committed");
    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Must not stage." },
      responseContext,
    );
    expect(staged).toMatchObject({ status: "invalid_write", isError: true });
    expect(staged.text).toContain("already committed");

    ctx.coordinator.failWith(undefined);
    recover.mockImplementation(originalRecover);
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("rejects staging while a response commit owns its snapshot", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-stage-during-commit";
    const responseContext = { ...context, turnId: "turn-stage-during-commit", responseId };
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    const appendStarted = deferred<void>();
    const releaseAppend = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return originalAppend(entries);
    };

    const commit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Too late." },
      responseContext,
    );
    expect(staged.status).toBe("internal_error");
    releaseAppend.resolve();
    await commit;
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("does not drop a commit snapshot while append is in progress", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
    );
    const responseId = "response-drop-during-append";
    const responseContext = { ...context, turnId: "turn-drop-during-append", responseId };
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    const appendStarted = deferred<void>();
    const releaseAppend = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return originalAppend(entries);
    };
    const commit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    await ctx.core.invalidateThread("chapter.md", THREAD_ID);
    releaseAppend.resolve();
    const result = await commit;
    if (result.status !== "committed") throw new Error("expected committed response");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
    expect(result.discardedClaims).toBeUndefined();
    expect(
      transitions
        .filter((event) => event.transition === "closed")
        .map((event) => event.closedOutcome),
    ).toEqual(["committed"]);
  });

  it("rejects rollback after commit has acquired lifecycle ownership", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-commit-vs-rollback";
    const responseContext = { ...context, turnId: "turn-commit-vs-rollback", responseId };
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    const appendStarted = deferred<void>();
    const releaseAppend = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return originalAppend(entries);
    };
    const commit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    await expect(ctx.core.rollbackResponse(responseId)).rejects.toThrow(
      "commit is already in progress",
    );
    releaseAppend.resolve();
    await commit;
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("does not reclassify a durable journal commit when onTransition throws on journal_committed", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => {
          transitions.push(event);
          if (event.transition === "journal_committed") {
            throw new Error("observer exploded");
          }
        },
      },
    );
    const responseContext = {
      ...context,
      turnId: "turn-observer-throw",
      responseId: "response-observer-throw",
    };

    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const commit = await ctx.core.commitResponse("response-observer-throw");

    expect(commit).toMatchObject({
      responseId: "response-observer-throw",
      documentCount: 1,
      updateCount: 1,
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
    expect(transitions.map((event) => event.transition)).toEqual(
      expect.arrayContaining(["journal_committed", "closed"]),
    );
    expect(transitions.find((event) => event.transition === "closed")).toMatchObject({
      closedOutcome: "committed",
      threadId: context.threadId,
    });
  });

  it("does not reclassify a durable journal commit when onClaimDiscarded throws", async () => {
    const ctx = harness(
      { "alpha.md": "Alpha.", "beta.md": "Beta." },
      {
        onResponseClaimDiscarded: () => {
          throw new Error("claim observer exploded");
        },
      },
    );
    await ctx.core.write({ command: "read", file: "alpha.md" }, context);
    await ctx.core.write({ command: "read", file: "beta.md" }, context);
    const responseId = "response-claim-observer-throw";
    const responseContext = {
      ...context,
      turnId: "turn-claim-observer-throw",
      responseId,
    };

    await ctx.core.write(
      { command: "insert", file: "alpha.md", content: "Alpha tail." },
      responseContext,
    );
    await ctx.core.write(
      { command: "insert", file: "beta.md", content: "Beta tail." },
      responseContext,
    );
    await ctx.core.invalidateThread("alpha.md", THREAD_ID);

    const commit = await ctx.core.commitResponse(responseId);

    expect(commit).toMatchObject({
      responseId,
      documentCount: 1,
      updateCount: 1,
      discardedClaims: [{ documentId: "alpha.md", threadId: THREAD_ID }],
    });
    expect((await ctx.journal.read("beta.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["Beta.", "Beta tail."]);
  });

  it("appends exactly one journal batch when commitResponse is invoked concurrently", async () => {
    let appendBatchInFlight = 0;
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        journalOverride: (journal) => {
          const originalAppendBatch = journal.appendBatch.bind(journal);
          const gated = journal as typeof journal & {
            appendBatch: typeof journal.appendBatch;
          };
          gated.appendBatch = async (entries) => {
            appendBatchInFlight += 1;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });
            try {
              return await originalAppendBatch(entries);
            } finally {
              appendBatchInFlight -= 1;
            }
          };
          return gated as UpdateJournal & ReversalStore;
        },
      },
    );
    const responseId = "response-concurrent-commit";
    const responseContext = {
      ...context,
      turnId: "turn-concurrent-commit",
      responseId,
    };

    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const appendStarted = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      return originalAppend(entries);
    };
    const firstCommit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    expect(appendBatchInFlight).toBe(1);
    const secondCommit = ctx.core.commitResponse(responseId);
    await Promise.resolve();
    expect(appendBatchInFlight).toBe(1);

    const [first, second] = await Promise.all([firstCommit, secondCommit]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ responseId, documentCount: 1, updateCount: 1 });
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("projects committed updates when invalidateThread runs during journal_committed", async () => {
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => {
          if (event.transition === "journal_committed") {
            void ctx.core.invalidateThread("chapter.md", THREAD_ID);
          }
        },
      },
    );
    const responseId = "response-invalidate-mid-commit";
    const responseContext = {
      ...context,
      turnId: "turn-invalidate-mid-commit",
      responseId,
    };

    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const commit = await ctx.core.commitResponse(responseId);

    expect(commit).toMatchObject({
      responseId,
      documentCount: 1,
      updateCount: 1,
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });
});

async function stageBlindOverwrite(
  ctx: ReturnType<typeof harness>,
  responseId: string,
  content: string,
): Promise<void> {
  await ctx.core.write(
    { command: "create", file: "chapter.md", content, overwrite: true },
    {
      ...context,
      responseId,
      turnId: `${responseId}-turn`,
      createdDocument: false,
    },
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
