/** Reversal projection behavior at host transaction boundaries. */
import { describe, expect, it } from "vitest";

import { blockTexts, expectOutcome } from "./test-support/assertions.js";
import { context, harness } from "./test-support/write-tool-harness.js";

describe("write reversal transaction projection", () => {
  it("does not project a persisted reversal until the host transaction commits", async () => {
    const afterCommit: Array<() => void | Promise<void>> = [];
    const ctx = harness(
      { "chapter.md": "Base." },
      {
        deferUntilCommit(callback) {
          afterCommit.push(callback);
          return true;
        },
      },
    );
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Deferred reversal target." },
      { ...context, turnId: "turn-deferred-reversal" },
    );

    const undo = await ctx.core.reverse({
      docId: "chapter.md",
      threadId: context.threadId,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-deferred-reversal" },
      actor: { type: "user", userId: "user-1" },
    });

    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toContain("Deferred reversal target.");
    expect(afterCommit).toHaveLength(1);

    await afterCommit[0]?.();

    expect(blockTexts(ctx.liveDoc("chapter.md"))).not.toContain("Deferred reversal target.");
  });
});
