// Write-level undo/redo selector, stack, and checkpoint contracts.
import { describe, expect, it } from "vitest";

import { outcomeText } from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { context, REVERSAL_CLIENT_ID, THREAD_ID } from "./test-support/write-tool-harness.js";

describe("write reversal selectors", () => {
  it("undoes and redoes a write whose update is hidden by a checkpoint", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const { ctx } = scenario;
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta arrives." },
      { ...context, turnId: "turn-checkpointed-write" },
    );

    await scenario.checkpointLiveDoc(1);

    expect((await ctx.journal.read("chapter.md")).updates).toEqual([]);
    expect(
      (await ctx.journal.readForReconstruction("chapter.md")).updates.map((u) => u.seq),
    ).toEqual([1]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w1",
    });

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(undo)).toContain("status: reversed");
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("status: reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta arrives."]);
  });

  it("undoes the range from since to to, by numeric ordinal past w10", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.appendBlocks(Array.from({ length: 11 }, (_, index) => `Block ${index + 1}.`));

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", since: "w2", to: "w10" },
      context,
    );

    expect(outcomeText(undo)).toContain("undo: w2, w3, w4, w5, w6, w7, w8, w9, w10");
    expect(scenario.blockTexts()).toEqual(["Base.", "Block 1.", "Block 11."]);
    expect(await scenario.mutationsFor("w10")).toMatchObject([{ status: "reversed" }]);
    expect(await scenario.mutationsFor("w11")).toMatchObject([{ status: "active" }]);
  });

  it("supports last and all selectors", async () => {
    const last = await ReversalScenario.read({ "chapter.md": "Base." });
    await last.appendBlocks(["One.", "Two.", "Three.", "Four."]);
    await last.ctx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context);
    expect(last.blockTexts()).toEqual(["Base.", "One.", "Two."]);

    const all = await ReversalScenario.read({ "chapter.md": "Base." });
    await all.appendBlocks(["One.", "Two.", "Three."]);
    await all.ctx.core.write({ command: "undo", file: "chapter.md", all: true }, context);
    expect(all.blockTexts()).toEqual(["Base."]);
  });

  /** Three independent writes, each undone on its own (w3, then w2, then w1). */
  async function threeSeparatelyUndone(): Promise<ReversalScenario> {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.appendBlocks(["One.", "Two.", "Three."]);
    for (let index = 0; index < 3; index += 1) {
      await scenario.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    }
    expect(scenario.blockTexts()).toEqual(["Base."]);
    return scenario;
  }

  it.each([
    [1, "w1", ["Base.", "One."]],
    [2, "w1, w2", ["Base.", "One.", "Two."]],
    [3, "w1, w2, w3", ["Base.", "One.", "Two.", "Three."]],
  ] as const)("redo last %i counts the most recently undone handles and redoes %s", async (last, handles, texts) => {
    const scenario = await threeSeparatelyUndone();

    const redo = await scenario.ctx.core.write(
      { command: "redo", file: "chapter.md", last },
      context,
    );

    expect(outcomeText(redo)).toContain(`redo: ${handles}`);
    expect(scenario.blockTexts()).toEqual(texts);
  });

  it("redoes the same write for a plain redo and for redo last 1 after targeted undos", async () => {
    const run = async (redo: { last?: number }) => {
      const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
      await scenario.appendBlocks(["One.", "Two.", "Three."]);
      await scenario.ctx.core.write({ command: "undo", file: "chapter.md", to: "w3" }, context);
      await scenario.ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);
      const result = await scenario.ctx.core.write(
        { command: "redo", file: "chapter.md", ...redo },
        context,
      );
      return { text: outcomeText(result), blocks: scenario.blockTexts() };
    };

    const latest = await run({});
    const lastOne = await run({ last: 1 });

    expect(latest.text).toContain("redo: w1");
    expect(lastOne.text).toContain("redo: w1");
    expect(lastOne.blocks).toEqual(latest.blocks);
    expect(lastOne.blocks).toEqual(["Base.", "One.", "Two."]);
  });

  it("redoes every undo group a since/to range touches", async () => {
    const scenario = await threeSeparatelyUndone();

    const redo = await scenario.ctx.core.write(
      { command: "redo", file: "chapter.md", since: "w1", to: "w2" },
      context,
    );

    expect(outcomeText(redo)).toContain("redo: w1, w2");
    expect(scenario.blockTexts()).toEqual(["Base.", "One.", "Two."]);
  });
});
