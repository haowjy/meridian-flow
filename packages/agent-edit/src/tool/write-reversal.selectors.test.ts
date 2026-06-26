// Write-level undo/redo selector, stack, and checkpoint contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { parseWriteHandle } from "../ports/update-journal.js";
import { expectOutcome, outcomeText } from "./test-support/assertions.js";
import { ReversalScenario, setStoredUpdateTime } from "./test-support/write-reversal-scenario.js";
import { context, REVERSAL_CLIENT_ID, THREAD_ID } from "./test-support/write-tool-harness.js";

describe("write reversal selectors", () => {
  it("flips mutation status when undoing and redoing a write", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Alpha sword." });
    const { ctx } = scenario;
    await scenario.simpleReplace("turn-mutation-status");

    expect(await scenario.mutationsFor("w1")).toMatchObject([
      { handle: "w1", turnId: "turn-mutation-status", status: "active", createdSeq: 1 },
    ]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(outcomeText(undo)).toContain("status: reconciled");
    const [reversal] = await ctx.journal.readReversals("chapter.md", {
      threadId: THREAD_ID,
      status: ["reversed"],
    });
    expect(reversal).toMatchObject({
      turnId: "turn-mutation-status",
      writeIds: ["w1"],
      threadId: THREAD_ID,
      status: "reversed",
    });
    expect(reversal?.undoUpdateSeq).toBeGreaterThan(0);
    expect(await scenario.mutationsFor("w1")).toMatchObject([
      { status: "reversed", undoUpdateSeq: reversal?.undoUpdateSeq },
    ]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toContain("status: reconciled");
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toMatchObject([
      { turnId: "turn-mutation-status", writeIds: ["w1"], status: "redone" },
    ]);
  });

  it("defaults to the latest write in a multi-write turn and redoes in stack order", async () => {
    const scenario = await ReversalScenario.view(
      { "chapter.md": "Alpha." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const { ctx } = scenario;
    const turnContext = { ...context, turnId: "turn-with-two-writes" };
    await ctx.core.write({ command: "insert", file: "chapter.md", content: "A." }, turnContext);
    await ctx.core.write({ command: "insert", file: "chapter.md", content: "B." }, turnContext);

    expect(scenario.blockTexts()).toEqual(["Alpha.", "A.", "B."]);
    expect(
      outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("undo: 1 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha.", "A."]);
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(scenario.blockTexts()).toEqual(["Alpha."]);

    await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(scenario.blockTexts()).toEqual(["Alpha.", "A."]);
    await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(scenario.blockTexts()).toEqual(["Alpha.", "A.", "B."]);
  });

  it("undoes and redoes a write whose update is hidden by a checkpoint", async () => {
    const scenario = await ReversalScenario.view(
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

  it("targets one write without disturbing later writes", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.appendBlocks(["A.", "B.", "C."]);

    await scenario.ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);

    expect(scenario.blockTexts()).toEqual(["Base.", "B.", "C."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "reversed" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w3")).toMatchObject([{ status: "active" }]);
  });

  it("targets an inclusive write range", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.appendBlocks(["One.", "Two.", "Three.", "Four.", "Five."]);

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w4" },
      context,
    );

    expect(outcomeText(undo)).toContain("undo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Base.", "One.", "Five."]);
  });

  it("targets write ranges by numeric ordinal past w10", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
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

  it("compares write handles by numeric ordinal", async () => {
    const handles = ["w1", "w2", "w10", "w11"].sort((left, right) => {
      const leftOrdinal = parseWriteHandle(left) ?? 0;
      const rightOrdinal = parseWriteHandle(right) ?? 0;
      return leftOrdinal - rightOrdinal;
    });

    expect(handles).toEqual(["w1", "w2", "w10", "w11"]);
  });

  it("targets a range across turns", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.appendBlocks(["One.", "Two."], "turn-a");
    await scenario.appendBlocks(["Three.", "Four."], "turn-b");

    await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w3" },
      context,
    );

    expect(scenario.blockTexts()).toEqual(["Base.", "One.", "Four."]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([
      { turnId: "turn-a-1", status: "reversed" },
    ]);
    expect(await scenario.mutationsFor("w3")).toMatchObject([
      { turnId: "turn-b-0", status: "reversed" },
    ]);
  });

  it("redoes a grouped undo by undo update sequence", async () => {
    const scenario = await ReversalScenario.view(
      { "chapter.md": "Base." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.appendBlocks(["One.", "Two.", "Three."]);
    const afterWrites = scenario.blockTexts();

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w1", to: "w3" },
      context,
    );
    expect(outcomeText(undo)).toContain("undo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Base."]);

    const redo = await scenario.ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("redo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(afterWrites);
    for (const writeId of ["w1", "w2", "w3"]) {
      expect(await scenario.mutationsFor(writeId)).toMatchObject([{ status: "active" }]);
    }
  });

  it("supports last and all selectors", async () => {
    const last = await ReversalScenario.view({ "chapter.md": "Base." });
    await last.appendBlocks(["One.", "Two.", "Three.", "Four."]);
    await last.ctx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context);
    expect(last.blockTexts()).toEqual(["Base.", "One.", "Two."]);

    const all = await ReversalScenario.view({ "chapter.md": "Base." });
    await all.appendBlocks(["One.", "Two.", "Three."]);
    await all.ctx.core.write({ command: "undo", file: "chapter.md", all: true }, context);
    expect(all.blockTexts()).toEqual(["Base."]);
  });

  it("undo all skips compacted-away writes and reverses the retained subset", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    const { ctx } = scenario;
    await scenario.appendBlocks(["One."]);
    const afterW1 = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", find: "Base" },
      { ...context, turnId: "turn-second" },
    );
    setStoredUpdateTime(ctx.journal, "chapter.md", 1, new Date("2026-01-01T00:00:00.000Z"));
    setStoredUpdateTime(ctx.journal, "chapter.md", 2, new Date("2026-01-03T00:00:00.000Z"));
    await ctx.journal.checkpoint("chapter.md", afterW1, 1);
    await ctx.journal.compact("chapter.md", new Date("2026-01-02T00:00:00.000Z"));

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", all: true }, context);

    expectOutcome(undo, "reconciled");
    expect(outcomeText(undo)).toContain("undo: 1 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Base.", "One."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "reversed" }]);
  });
});
