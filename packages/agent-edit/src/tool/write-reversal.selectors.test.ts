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

  it("targets write ranges by numeric ordinal past w10", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.appendBlocks(Array.from({ length: 11 }, (_, index) => `Block ${index + 1}.`));

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w10" },
      context,
    );

    expect(outcomeText(undo)).toContain("undo: 9 edit(s)");
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
});
