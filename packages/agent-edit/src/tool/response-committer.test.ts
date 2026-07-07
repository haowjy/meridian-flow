// Response committer lifecycle invariants: observer failures must not alter outcomes.
import { describe, expect, it } from "vitest";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import { blockTexts } from "./test-support/assertions.js";
import { context, harness, THREAD_ID } from "./test-support/write-tool-harness.js";
import type { ResponseCommitterTransitionDetail } from "./types.js";

describe("response committer", () => {
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
