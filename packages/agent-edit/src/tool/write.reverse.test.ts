// Host reverse() API coverage for user-facing write, turn, and thread reversal scopes.
import { describe, expect, it } from "vitest";

import { blockTexts, expectOutcome } from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { context, THREAD_ID } from "./test-support/write-tool-harness.js";

const actor = { type: "user", userId: "user-1" } as const;

describe("write host reverse", () => {
  it("undoes the latest write when write scope has no target", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-one" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Two." },
      { ...context, turnId: "turn-two" },
    );

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });

    expectOutcome(undo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
    expect(scenario.ctx.journal.reversalRecords("chapter.md")).toMatchObject([
      { writeIds: ["w2"], reversedByUserId: "user-1" },
    ]);
  });

  it("undoes a targeted write by id", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-one" },
    );

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "single", to: "w1" },
      actor,
    });

    expectOutcome(undo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
  });

  it("undoes all writes in a turn", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-target" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Two." },
      { ...context, turnId: "turn-target" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Later." },
      { ...context, turnId: "turn-later" },
    );

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-target" },
      actor,
    });

    expectOutcome(undo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "Later."]);
  });

  it("undoes the whole thread", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.appendBlocks(["One.", "Two."], "turn-thread");

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "all" },
      actor,
    });

    expectOutcome(undo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
  });

  it("redoes a reversed turn", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-redo" },
    );
    await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-redo" },
      actor,
    });

    const redo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "turn", turnId: "turn-redo" },
      actor,
    });

    expectOutcome(redo, "reconciled");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
  });

  it("redoes all reversed groups in a turn", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-redo-groups" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Two." },
      { ...context, turnId: "turn-redo-groups" },
    );

    expectOutcome(
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "single", to: "w2" },
        actor,
      }),
      "reversed",
    );
    expectOutcome(
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "single", to: "w1" },
        actor,
      }),
      "reversed",
    );
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);

    const redo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "turn", turnId: "turn-redo-groups" },
      actor,
    });

    expectOutcome(redo, "reconciled");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Two."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "active" }]);
  });
});
