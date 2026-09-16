// Response committer lifecycle invariants: observer failures must not alter outcomes.
import { describe, expect, it, vi } from "vitest";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import { blockTexts } from "./test-support/assertions.js";
import { context, harness, THREAD_ID } from "./test-support/write-tool-harness.js";
import type { ResponseCommitterTransitionDetail } from "./types.js";

describe("response committer", () => {
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
    expect(ctx.core.hasResponseDocument(responseId, "chapter.md")).toBe(true);
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
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
