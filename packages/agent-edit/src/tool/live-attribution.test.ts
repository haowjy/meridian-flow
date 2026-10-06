// Live-save attribution reads only the journal rows after the model's read.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { JournalReadOptions } from "../ports/update-journal.js";
import { expectOutcome, humanText } from "./test-support/assertions.js";
import { context, harness } from "./test-support/write-tool-harness.js";

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
