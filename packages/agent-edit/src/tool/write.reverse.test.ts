// Host reverse() API coverage for user-facing write, turn, and thread reversal scopes.
import { describe, expect, it, vi } from "vitest";

import { blockTexts, expectOutcome } from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { context, THREAD_ID } from "./test-support/write-tool-harness.js";

const actor = { type: "user", userId: "user-1" } as const;

describe("write host reverse", () => {
  it("allows an agent edit immediately after a user-actor hosted undo", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Undone." },
      { ...context, turnId: "turn-undone" },
    );
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "Undone."]);

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });
    expectOutcome(undo, "reversed");

    const edit = await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "After undo." },
      { ...context, turnId: "turn-after-user-undo" },
    );

    expectOutcome(edit, "success");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "After undo."]);
  });

  it("undoes a targeted write by id", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
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
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
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
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
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

  it("supports undo → redo → undo again for turn-scoped reversal", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-cycle" },
    );

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-cycle" },
      actor,
    });
    expectOutcome(undo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);

    const redo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "turn", turnId: "turn-cycle" },
      actor,
    });
    expectOutcome(redo, "reconciled");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await scenario.ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w1",
    });

    const secondUndo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-cycle" },
      actor,
    });
    expectOutcome(secondUndo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);

    const secondRedo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "turn", turnId: "turn-cycle" },
      actor,
    });
    expectOutcome(secondRedo, "reconciled");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
  });

  it("keeps a persisted user reversal successful when notification recording fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Array<{
      threadId: string;
      docId: string;
      representativeTurnId: string | null | undefined;
      direction: "undo" | "redo";
      writeHandleCount: number;
      cause: string;
    }> = [];
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Base." },
      {
        reversalNoticePort: {
          async record() {
            throw new Error("notification insert failed");
          },
        },
        onReversalNoticeFailed: (event) => {
          failures.push(event);
        },
      },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-notification-failure" },
    );

    try {
      const undo = await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "latest" },
        actor,
      });

      expectOutcome(undo, "reversed");
      expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
      expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "reversed" }]);
      expect(failures).toEqual([
        {
          threadId: THREAD_ID,
          docId: "chapter.md",
          representativeTurnId: "turn-notification-failure",
          direction: "undo",
          writeHandleCount: 1,
          cause: "notification insert failed",
        },
      ]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
