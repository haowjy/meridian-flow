// Response committer lifecycle invariants: observer failures must not alter outcomes.
import { describe, expect, it, vi } from "vitest";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import { blockTexts } from "./test-support/assertions.js";
import { context, harness, THREAD_ID } from "./test-support/write-tool-harness.js";
import type { ResponseCommitterTransitionDetail } from "./types.js";

describe("response committer", () => {
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
    expect(projectionCount).toBe(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("closes a durable response when projection and recovery both fail", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
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

    ctx.coordinator.failWith(new Error("projection failed"));
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

    const firstCommit = ctx.core.commitResponse(responseId);
    await Promise.resolve();
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
