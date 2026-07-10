// Host reverse() API coverage for user-facing write, turn, and thread reversal scopes.
import { describe, expect, it, vi } from "vitest";

import { blockTexts, expectOutcome } from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { context, THREAD_ID } from "./test-support/write-tool-harness.js";

const actor = { type: "user", userId: "user-1" } as const;

describe("write host reverse", () => {
  it("fences agent-actor hosted reversal but exempts user intent", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Reversible." },
      { ...context, turnId: "turn-reversible" },
    );
    scenario.ctx.core.setReadRequiredFence(THREAD_ID, ["chapter.md"]);

    await expect(
      scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "latest" },
        actor: { type: "agent" },
      }),
    ).resolves.toMatchObject({ status: "rejected_response_requires_reread", isError: true });

    await expect(
      scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "latest" },
        actor,
      }),
    ).resolves.toMatchObject({ status: "reversed", isError: false });
  });

  it("undoes the latest write when write scope has no target", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
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

  it("reports a delete-only inverse update as an effect when required", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Inserted." },
      { ...context, turnId: "turn-delete-only-effect" },
    );

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
      requireEffect: true,
    });

    expectOutcome(undo, "reversed");
    expect(undo).toMatchObject({ reversalEffect: "changed" });
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
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

  it("undoes every latest-turn group even when the first group reports an earlier turn id", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "A." },
      { ...context, turnId: "turn-a" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Target one." },
      { ...context, turnId: "turn-target" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "B." },
      { ...context, turnId: "turn-b" },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Target two." },
      { ...context, turnId: "turn-target" },
    );

    expectOutcome(
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "range", from: "w1", to: "w2" },
        actor,
      }),
      "reversed",
    );
    expectOutcome(
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "redo",
        selection: { kind: "turn", turnId: "turn-target" },
        actor,
      }),
      "reconciled",
    );

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn" },
      actor,
    });

    expectOutcome(undo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "B."]);
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

  it("redoes a reversed turn", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
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

  it("supports undo → redo → undo again for single-write reversal", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-single-cycle" },
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

    expectOutcome(
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "redo",
        selection: { kind: "single", to: "w1" },
        actor,
      }),
      "reconciled",
    );
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
      selection: { kind: "single", to: "w1" },
      actor,
    });
    expectOutcome(secondUndo, "reversed");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);

    const secondRedo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "single", to: "w1" },
      actor,
    });
    expectOutcome(secondRedo, "reconciled");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
  });

  it("redoes all reversed groups in a turn", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
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
  it("records undo notifications for user reversals only", async () => {
    const records: Array<{
      threadId: string;
      writeHandles: string[];
      writeHandleTurns: readonly { writeHandle: string; turnId: string | null }[];
      docId: string;
      direction: "undo" | "redo";
    }> = [];
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Base." },
      {
        undoNotificationPort: {
          async record(input) {
            records.push(input);
          },
        },
      },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-user-notification" },
    );

    await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });
    await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "latest" },
      actor: { type: "agent" },
    });

    expect(records).toEqual([
      {
        threadId: THREAD_ID,
        writeHandles: ["w1"],
        writeHandleTurns: [{ writeHandle: "w1", turnId: "turn-user-notification" }],
        docId: "chapter.md",
        direction: "undo",
        sweptContent: false,
        beforeContentRef: null,
      },
    ]);
  });

  it("records redo notifications for user reversals", async () => {
    const records: Array<{ direction: "undo" | "redo"; writeHandles: string[] }> = [];
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Base." },
      {
        undoNotificationPort: {
          async record(input) {
            records.push({ direction: input.direction, writeHandles: input.writeHandles });
          },
        },
      },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-redo-notification" },
    );

    await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });
    await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "latest" },
      actor,
    });

    expect(records).toEqual([
      { direction: "undo", writeHandles: ["w1"] },
      { direction: "redo", writeHandles: ["w1"] },
    ]);
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
        undoNotificationPort: {
          async record() {
            throw new Error("notification insert failed");
          },
        },
        onUndoNotificationFailed: (event) => {
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

  it("logs undo notification failures to console when no host observer is wired", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Base." },
      {
        undoNotificationPort: {
          async record() {
            throw new Error("notification insert failed");
          },
        },
      },
    );
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      { ...context, turnId: "turn-console-fallback" },
    );

    try {
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "latest" },
        actor,
      });

      expect(consoleError).toHaveBeenCalledWith(
        "agent-edit undo notification recording failed",
        expect.objectContaining({
          threadId: THREAD_ID,
          docId: "chapter.md",
          representativeTurnId: "turn-console-fallback",
          direction: "undo",
          writeHandleCount: 1,
          cause: "notification insert failed",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
