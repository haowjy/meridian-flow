// Write-level undo dependent-edit guard contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  blockTexts,
  expectNoInternalIds,
  expectOutcome,
  humanText,
  outcomeText,
} from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { context, model, REVERSAL_CLIENT_ID } from "./test-support/write-tool-harness.js";

describe("write reversal dependencies", () => {
  it("refuses the swordblade case when a later undone write consumed the selected write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undoLater = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md" },
      context,
    );
    expectOutcome(undoLater, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha blade."]);

    const undoEarlier = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md" },
      context,
    );

    expectOutcome(undoEarlier, "cant_undo_dependent", true);
    expect(outcomeText(undoEarlier)).toContain("w2 was built on it");
    expect(outcomeText(undoEarlier)).toContain("undo the range w1..w2");
    expectNoInternalIds(outcomeText(undoEarlier));
    expect(outcomeText(undoEarlier)).not.toMatch(/\b(Yjs|struct|delete set|documentId)\b/i);
    expect(scenario.blockTexts()).toEqual(["Alpha blade."]);
  });

  it("refuses the swordsaber case while the dependent later write is still active", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undoEarlier = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", to: "w1" },
      context,
    );

    expectOutcome(undoEarlier, "cant_undo_dependent", true);
    expect(outcomeText(undoEarlier)).toContain("w2 was built on it");
    expect(scenario.blockTexts()).toEqual(["Alpha saber."]);
  });

  it("allows a range that contains the dependent write cluster", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w1", to: "w2" },
      context,
    );

    expectOutcome(undo, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);
  });

  it("allows all when it contains the dependent write cluster", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", all: true },
      context,
    );

    expectOutcome(undo, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);
  });

  it("allows the default newest single undo in a dependent cluster", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undo = await scenario.ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expectOutcome(undo, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha blade."]);
  });

  it("does not refuse a non-overlapping earlier write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword.\n\nBeta shield." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const { ctx } = scenario;
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-independent" },
    );
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "ward", find: "shield" },
      { ...context, turnId: "turn-independent" },
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);

    expectOutcome(undo, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta ward."]);
  });

  it("preserves same-area human edits when undoing a selected write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.simpleReplace("turn-human-overlap");
    humanText(
      scenario.ctx.liveDoc("chapter.md"),
      0,
      { from: "Alpha blade.".length, to: "Alpha blade.".length },
      " Human.",
    );

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", to: "w1" },
      context,
    );

    expect(outcomeText(undo)).toContain("status: reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha sword. Human."]);
  });

  it("refuses undo with generic wording when an untracked later edit depends on the write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Base." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.appendBlocks(["Dependent."]);

    const live = scenario.ctx.liveDoc("chapter.md");
    const beforeHuman = Y.encodeStateVector(live);
    const inserted = model.getBlocks(live)[1];
    if (!inserted) throw new Error("expected inserted block");
    live.transact(() => model.deleteBlock(live, inserted), { type: "human" });
    await scenario.ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeHuman), {
      origin: "human:user-a",
      seq: 0,
    });

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", to: "w1" },
      context,
    );

    expectOutcome(undo, "cant_undo_dependent", true);
    expect(outcomeText(undo)).toContain("a later edit was built on it");
    expectNoInternalIds(outcomeText(undo));
    expect(outcomeText(undo)).not.toMatch(/document|thread|undo update seq|Yjs|struct|delete set/i);
    expect(blockTexts(live)).toEqual(["Base."]);
  });
});
