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
import { context, harness, model, REVERSAL_CLIENT_ID } from "./test-support/write-tool-harness.js";

describe("write reversal dependencies", () => {
  it("ignores a later already-reversed write when checking selected-write dependencies", async () => {
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

    expectOutcome(undoEarlier, "reconciled");
    expectNoInternalIds(outcomeText(undoEarlier));
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);
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

  it.each([
    {
      label: "range contains the dependent write cluster",
      command: { command: "undo", file: "chapter.md", from: "w1", to: "w2" } as const,
      blocks: ["Alpha sword."],
    },
    {
      label: "all contains the dependent write cluster",
      command: { command: "undo", file: "chapter.md", all: true } as const,
      blocks: ["Alpha sword."],
    },
    {
      label: "default newest single undo in a dependent cluster",
      command: { command: "undo", file: "chapter.md" } as const,
      blocks: ["Alpha blade."],
    },
  ])("allows $label", async ({ command, blocks }) => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undo = await scenario.ctx.core.write(command, context);

    expectOutcome(undo, "reconciled");
    expect(scenario.blockTexts()).toEqual(blocks);
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

  it("refuses undo when a live row lands after the checked high-watermark before persistence", async () => {
    let liveDoc: Y.Doc | undefined;
    let injected = false;
    const ctx = harness(
      { "chapter.md": "Alpha sword." },
      {
        undoClientId: REVERSAL_CLIENT_ID,
        journalOverride: (journal) =>
          new Proxy(journal, {
            get(target, prop, receiver) {
              if (prop === "persistUndo") {
                return async (...args: Parameters<typeof journal.persistUndo>) => {
                  if (!injected) {
                    if (!liveDoc) throw new Error("live document not captured");
                    const beforeHuman = Y.encodeStateVector(liveDoc);
                    humanText(
                      liveDoc,
                      0,
                      { from: "Alpha blade.".length, to: "Alpha blade.".length },
                      " Human.",
                    );
                    await journal.append(
                      "chapter.md",
                      Y.encodeStateAsUpdate(liveDoc, beforeHuman),
                      { origin: "human:user-a", seq: 0 },
                    );
                    injected = true;
                  }
                  return target.persistUndo(...args);
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    liveDoc = ctx.liveDoc("chapter.md");
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-race" },
    );
    const checkedUntilSeq = (ctx.journal.debugEntry("chapter.md")?.nextSeq ?? 1) - 1;

    const undo = await ctx.core.reverse({
      docId: "chapter.md",
      threadId: context.threadId,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-race" },
      actor: { type: "user", userId: "user-a" },
      commitGuard: {
        expectedLatestSeq: checkedUntilSeq,
        failureStatus: "cant_undo_dependent",
        failureMessage: "Injected dependent row.",
      },
    });

    expect(injected).toBe(true);
    expectOutcome(undo, "cant_undo_dependent", true);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade. Human."]);
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
  it("expands sword→blade→saber after undo/redo cycling the dependent group", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.writeDependentSwordSaber();

    const undoGroup = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w1", to: "w2" },
      context,
    );
    expectOutcome(undoGroup, "reconciled");
    const redoGroup = await scenario.ctx.core.write(
      { command: "redo", file: "chapter.md" },
      context,
    );
    expectOutcome(redoGroup, "reconciled");

    const undoEarlier = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", to: "w1" },
      context,
    );

    expectOutcome(undoEarlier, "reconciled");
    expect(outcomeText(undoEarlier)).toContain("undo: 2 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);
  });

  it("does not silently partial-undo a diverged turn scope", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword.\n\nBeta shield." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      { ...context, turnId: "turn-diverged" },
    );
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "shield", content: "ward" },
      { ...context, turnId: "turn-diverged" },
    );
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward."]);

    expectOutcome(
      await scenario.ctx.core.write({ command: "undo", file: "chapter.md", all: true }, context),
      "reconciled",
    );
    expectOutcome(
      await scenario.ctx.core.write({ command: "redo", file: "chapter.md" }, context),
      "reconciled",
    );
    expectOutcome(
      await scenario.ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context),
      "reconciled",
    );
    expectOutcome(
      await scenario.ctx.core.write({ command: "redo", file: "chapter.md", to: "w1" }, context),
      "reconciled",
    );

    const undoTurn = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", all: true },
      context,
    );

    expect(["reconciled", "cant_undo_dependent"]).toContain(undoTurn.status);
    expect(scenario.blockTexts()).not.toEqual(["Alpha sword.", "Beta ward."]);
  });
});
