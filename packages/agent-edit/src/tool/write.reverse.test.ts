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
      scope: "write",
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
      scope: "write",
      target: "w1",
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
      scope: "turn",
      target: "turn-target",
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
      scope: "thread",
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
      scope: "turn",
      target: "turn-redo",
      actor,
    });

    const redo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      scope: "turn",
      target: "turn-redo",
      actor,
    });

    expectOutcome(redo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
  });
});
