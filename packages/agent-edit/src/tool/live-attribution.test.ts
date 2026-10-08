// Live-save attribution reads only the journal rows after the model's read.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { JournalReadOptions } from "../ports/update-journal.js";
import { expectOutcome, humanText } from "./test-support/assertions.js";
import { context, harness } from "./test-support/write-tool-harness.js";

vi.mock("yjs", async (importOriginal) => {
  const actual = await importOriginal<typeof Y>();
  return { ...actual, encodeStateAsUpdate: vi.fn(actual.encodeStateAsUpdate) };
});

type Harness = ReturnType<typeof harness>;

async function writerTypes(ctx: Harness, blockIndex: number, text: string): Promise<number> {
  const live = ctx.liveDoc("chapter.md");
  const before = Y.encodeStateVector(live);
  humanText(live, blockIndex, { from: 0, to: 0 }, text);
  return ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, before), {
    origin: "human:writer",
    seq: 0,
  });
}

function attributionReads(read: { mock: { calls: unknown[][] } }): JournalReadOptions[] {
  return read.mock.calls
    .map((call) => (call[1] ?? {}) as JournalReadOptions)
    .filter((opts) => opts.fromCheckpoint === false);
}

describe("live attribution", () => {
  it("reads only rows after the model's read and still names the writer", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nBeta.\n\nGamma." });
    for (let i = 0; i < 5; i += 1) await writerTypes(ctx, 2, `old${i} `);
    await ctx.core.read({ file: "chapter.md" }, context);
    const headAtRead = await ctx.journal.latestUpdateSeq("chapter.md");
    const read = vi.spyOn(ctx.journal, "read");
    const responseId = "response-bounded";

    const written = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.", content: "Alpha model." },
      { ...context, turnId: "turn-bounded", responseId },
    );
    await writerTypes(ctx, 1, "Writer ");
    const saved = await ctx.core.commitResponse(responseId);

    expectOutcome(written, "success");
    const reads = attributionReads(read);
    expect(reads.length).toBeGreaterThan(0);
    for (const opts of reads) expect(opts.since).toBeGreaterThanOrEqual(headAtRead);
    expect(saved.documents[0]?.concurrentEdits?.human).toHaveLength(1);
  });

  it("skips the journal when nothing landed after the model's read", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nBeta." });
    for (let i = 0; i < 3; i += 1) await writerTypes(ctx, 1, `old${i} `);
    await ctx.core.read({ file: "chapter.md" }, context);
    const read = vi.spyOn(ctx.journal, "read");
    const responseId = "response-quiet";

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.", content: "Alpha model." },
      { ...context, turnId: "turn-quiet", responseId },
    );
    const saved = await ctx.core.commitResponse(responseId);

    expect(attributionReads(read)).toEqual([]);
    expect(saved.documents[0]?.concurrentEdits).toBeUndefined();
  });
});

describe("reversal rows", () => {
  it("credits another thread's undo to its agent turn, not to the writer", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nBeta.\n\nGamma." });
    const threadA = { sessionId: "session-a", threadId: "thread-a" };
    const threadB = { sessionId: "session-b", threadId: "thread-b" };
    await ctx.core.read({ file: "chapter.md" }, threadA);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Gamma.", content: "Gamma agent." },
      { ...threadA, turnId: "turn-a-write" },
    );
    await ctx.core.read({ file: "chapter.md" }, threadB);
    const undone = await ctx.core.write(
      { command: "undo", file: "chapter.md" },
      { ...threadA, turnId: "turn-a-undo" },
    );
    const responseId = "response-b";

    await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.", content: "Alpha model." },
      { ...threadB, turnId: "turn-b", responseId },
    );
    const saved = await ctx.core.commitResponse(responseId);

    expectOutcome(undone, "reversed");
    const undoRow = (await ctx.journal.read("chapter.md")).updates.at(-2);
    expect(undoRow?.meta).toMatchObject({ origin: "system", actorTurnId: "turn-a-undo" });
    expect(saved.documents[0]?.concurrentEdits?.human ?? []).toEqual([]);
    expect(saved.documents[0]?.concurrentEdits?.agent).toHaveLength(1);
  });
});

describe("concurrent attribution workload", () => {
  it("attributes concurrent inserts and delete-only rows without serializing the document per row", async () => {
    async function saveWithRows(count: number) {
      const ctx = harness({ "chapter.md": "Alpha.\n\nBeta.\n\nGamma.\n\nDelta." });
      await ctx.core.read({ file: "chapter.md" }, context);
      const responseId = `response-workload-${count}`;
      await ctx.core.write(
        { command: "replace", file: "chapter.md", find: "Alpha.", content: "Alpha model." },
        { ...context, turnId: "turn-workload", responseId },
      );
      const live = ctx.liveDoc("chapter.md");
      for (let i = 0; i < count; i += 1) await writerTypes(ctx, 1, `writer${i} `);
      const beforeDelete = Y.encodeStateVector(live);
      humanText(live, 2, { from: 0, to: 3 }, "");
      expect(Y.encodeStateVector(live)).toEqual(beforeDelete);
      await ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeDelete), {
        origin: "human:deleter",
        seq: 0,
      });
      const beforeAgent = Y.encodeStateVector(live);
      humanText(live, 3, { from: 0, to: 0 }, "Agent ");
      await ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeAgent), {
        origin: "agent:other",
        actorTurnId: "other-turn",
        seq: 0,
      });
      const encode = vi.mocked(Y.encodeStateAsUpdate);
      encode.mockClear();
      try {
        const saved = await ctx.core.commitResponse(responseId);
        const serializations = encode.mock.calls.length;
        const attribution = saved.documents[0]?.concurrentEdits;
        expect(attribution?.human).toHaveLength(2);
        expect(attribution?.agent).toHaveLength(1);
        return serializations;
      } finally {
        encode.mockClear();
      }
    }
    const one = await saveWithRows(1);
    const twenty = await saveWithRows(20);
    // Bounded whole-state work: the growing journal must be applied incrementally.
    expect(twenty - one).toBeLessThan(10);
  });
});
