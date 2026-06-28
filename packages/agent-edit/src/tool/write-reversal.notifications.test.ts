// Notification payload contracts for user-triggered write reversal delivery.
import { describe, expect, it } from "vitest";

import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { context, THREAD_ID } from "./test-support/write-tool-harness.js";

const actor = { type: "user", userId: "user-1" } as const;

describe("write reversal notifications", () => {
  it("keeps per-handle turn metadata when undo all then redo by turn expands to the grouped boundary", async () => {
    const records = captureUndoNotifications();
    const scenario = await independentWriteScenario({ undoNotificationPort: records.port });

    const undoAll = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "all" },
      actor,
    });
    expect(undoAll.status).toBe("reconciled");
    expect(undoAll.text).toContain("undo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta shield.", "Gamma cloak."]);
    await expectMutationStatuses(scenario, { w1: "reversed", w2: "reversed", w3: "reversed" });
    await expectMutationTurns(scenario, {
      w1: "turn-boundary-w1",
      w2: "turn-boundary-w2",
      w3: "turn-boundary-w3",
    });

    const redoTurnB = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "turn", turnId: "turn-boundary-w2" },
      actor,
    });

    expect(redoTurnB.status).toBe("reconciled");
    expect(redoTurnB.text).toContain("redo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cape."]);
    await expectMutationStatuses(scenario, { w1: "active", w2: "active", w3: "active" });
    expect(
      (await scenario.ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).map(
        (record) => ({ writeIds: record.writeIds, turnId: record.turnId, status: record.status }),
      ),
    ).toEqual([
      { writeIds: ["w1"], turnId: "turn-boundary-w1", status: "redone" },
      { writeIds: ["w2"], turnId: "turn-boundary-w2", status: "redone" },
      { writeIds: ["w3"], turnId: "turn-boundary-w3", status: "redone" },
    ]);
    expect(records.turnsByHandle()).toEqual([
      {
        direction: "undo",
        turns: { w1: "turn-boundary-w1", w2: "turn-boundary-w2", w3: "turn-boundary-w3" },
      },
      {
        direction: "redo",
        turns: { w1: "turn-boundary-w1", w2: "turn-boundary-w2", w3: "turn-boundary-w3" },
      },
    ]);
  });

  it("pins range redo expansion to the full atomic undo boundary with per-handle turns", async () => {
    const records = captureUndoNotifications();
    const scenario = await independentWriteScenario({ undoNotificationPort: records.port });

    const undoAll = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "all" },
      actor,
    });
    expect(undoAll.status).toBe("reconciled");
    expect(undoAll.text).toContain("undo: 3 edit(s)");

    const redoRange = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "range", from: "w1", to: "w2" },
      actor,
    });

    expect(redoRange.status).toBe("reconciled");
    expect(redoRange.text).toContain("redo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cape."]);
    await expectMutationStatuses(scenario, { w1: "active", w2: "active", w3: "active" });
    expect(records.turnsByHandle().at(-1)).toEqual({
      direction: "redo",
      turns: { w1: "turn-boundary-w1", w2: "turn-boundary-w2", w3: "turn-boundary-w3" },
    });
  });

  it("keeps notification turns distinct when writes are redone in separate redo operations", async () => {
    const records = captureUndoNotifications();
    const scenario = await independentWriteScenario({ undoNotificationPort: records.port });

    for (const writeId of ["w3", "w2", "w1"]) {
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "single", to: writeId },
        actor,
      });
    }
    for (const writeId of ["w1", "w2", "w3"]) {
      await scenario.ctx.core.reverse({
        docId: "chapter.md",
        threadId: THREAD_ID,
        direction: "redo",
        selection: { kind: "single", to: writeId },
        actor,
      });
    }

    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cape."]);
    expect(records.turnsByHandle().slice(-3)).toEqual([
      { direction: "redo", turns: { w1: "turn-boundary-w1" } },
      { direction: "redo", turns: { w2: "turn-boundary-w2" } },
      { direction: "redo", turns: { w3: "turn-boundary-w3" } },
    ]);
  });
});

async function independentWriteScenario(
  options?: Parameters<typeof ReversalScenario.read>[1],
): Promise<ReversalScenario> {
  const scenario = await ReversalScenario.read(
    {
      "chapter.md": "Alpha sword.\n\nBeta shield.\n\nGamma cloak.",
    },
    options,
  );
  await scenario.ctx.core.write(
    { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
    { ...context, turnId: "turn-boundary-w1" },
  );
  await scenario.ctx.core.write(
    { command: "replace", file: "chapter.md", find: "shield", content: "ward" },
    { ...context, turnId: "turn-boundary-w2" },
  );
  await scenario.ctx.core.write(
    { command: "replace", file: "chapter.md", find: "cloak", content: "cape" },
    { ...context, turnId: "turn-boundary-w3" },
  );
  expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cape."]);
  return scenario;
}

function captureUndoNotifications() {
  const records: Array<{
    direction: "undo" | "redo";
    writeHandleTurns: readonly { writeHandle: string; turnId: string }[];
  }> = [];
  return {
    port: {
      async record(input: {
        direction: "undo" | "redo";
        writeHandleTurns: readonly { writeHandle: string; turnId: string }[];
      }) {
        records.push({
          direction: input.direction,
          writeHandleTurns: input.writeHandleTurns,
        });
      },
    },
    turnsByHandle() {
      return records.map((record) => ({
        direction: record.direction,
        turns: Object.fromEntries(
          record.writeHandleTurns.map((entry) => [entry.writeHandle, entry.turnId]),
        ),
      }));
    },
  };
}

async function expectMutationTurns(
  scenario: ReversalScenario,
  expected: Record<string, string>,
): Promise<void> {
  for (const [writeId, turnId] of Object.entries(expected)) {
    expect(await scenario.mutationsFor(writeId)).toMatchObject([{ turnId }]);
  }
}

async function expectMutationStatuses(
  scenario: ReversalScenario,
  expected: Record<string, "active" | "reversed">,
): Promise<void> {
  for (const [writeId, status] of Object.entries(expected)) {
    expect(await scenario.mutationsFor(writeId)).toMatchObject([{ status }]);
  }
}
