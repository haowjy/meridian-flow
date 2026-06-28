// Write-level reversal retention, drift, and thread-filtering contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import { blockTexts, expectOutcome, outcomeText } from "./test-support/assertions.js";
import {
  journalWithMissingMutationTarget,
  markStoredReversalStatus,
  ReversalScenario,
  setStoredUpdateTime,
} from "./test-support/write-reversal-scenario.js";
import {
  codec,
  context,
  model,
  REVERSAL_CLIENT_ID,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

describe("write reversal retention", () => {
  it("undoes a retained later replacement after compaction folded an earlier replacement", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword.\n\nBeta shield." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const { ctx } = scenario;

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-compacted-replace" },
    );
    await ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "ward", find: "shield" },
      { ...context, turnId: "turn-retained-replace" },
    );

    const undoLater = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expectOutcome(undoLater, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta shield."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "reversed" }]);

    const undoCompacted = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expectOutcome(undoCompacted, "nothing_to_undo");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta shield."]);

    const redoLater = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expectOutcome(redoLater, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward."]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "active" }]);

    const undoAll = await ctx.core.write(
      { command: "undo", file: "chapter.md", all: true },
      context,
    );
    expectOutcome(undoAll, "reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta shield."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "reversed" }]);
  });

  it("compacts only the contiguous old seq prefix when update timestamps are skewed", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
    const { ctx } = scenario;

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "First old write." },
      { ...context, turnId: "turn-old-prefix" },
    );
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Middle new write." },
      { ...context, turnId: "turn-new-gap" },
    );
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Later old write." },
      { ...context, turnId: "turn-old-after-gap" },
    );

    const oldEnough = new Date("2026-01-01T00:00:00.000Z");
    const tooNew = new Date("2026-01-03T00:00:00.000Z");
    const before = new Date("2026-01-02T00:00:00.000Z");
    setStoredUpdateTime(ctx.journal, "chapter.md", 1, oldEnough);
    setStoredUpdateTime(ctx.journal, "chapter.md", 2, tooNew);
    setStoredUpdateTime(ctx.journal, "chapter.md", 3, oldEnough);

    const compacted = await ctx.journal.compact("chapter.md", before);

    expect(compacted).toEqual({ updatesFolded: 1, reversalsExpired: 0 });
    expect(ctx.journal.updateRecords("chapter.md").map((update) => update.seq)).toEqual([2, 3]);
    expect((await ctx.journal.read("chapter.md")).updates.map((update) => update.seq)).toEqual([
      2, 3,
    ]);

    const undoLaterOldWrite = await ctx.core.write(
      { command: "undo", file: "chapter.md" },
      context,
    );

    expectOutcome(undoLaterOldWrite, "reversed");
    expect(scenario.blockTexts()).toEqual(["Base.", "First old write.", "Middle new write."]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w3")).toMatchObject([{ status: "reversed" }]);
  });

  it("undoes a retained later insert after compaction folded an earlier insert", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const { ctx } = scenario;

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, turnId: "turn-compacted-insert" },
    );
    await ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Gamma." },
      { ...context, turnId: "turn-retained-insert" },
    );

    const undoLater = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expectOutcome(undoLater, "reversed");
    expect(scenario.blockTexts()).toEqual(["Alpha.", "Beta."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "reversed" }]);
  });

  it("undoes a later write first, then a checkpointed earlier write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const { ctx } = scenario;
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta arrives." },
      { ...context, turnId: "turn-checkpointed-first" },
    );
    await scenario.checkpointLiveDoc(1);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Gamma follows." },
      { ...context, turnId: "turn-later-write" },
    );

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta arrives."]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "reversed" }]);

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "reversed" }]);
  });

  it("refuses redo when any in-memory reversal row in the group is no longer reversed", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Base." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.appendBlocks(["One.", "Two."]);
    await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w1", to: "w2" },
      context,
    );
    markStoredReversalStatus(scenario.ctx.journal, "chapter.md", "w1", "redone");

    const redo = await scenario.ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expectOutcome(redo, "nothing_to_redo");
    expect(scenario.blockTexts()).toEqual(["Base."]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "reversed" }]);
    expect(await scenario.mutationsFor("w2")).toMatchObject([{ status: "reversed" }]);
  });

  it("blocks redo after a forward write follows an undo", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Alpha sword." });
    const { ctx } = scenario;
    await scenario.simpleReplace("turn-redo-gate");
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoWriteId: "w1",
    });

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "New forward edit." },
      { ...context, turnId: "forward_update_after_undo" },
    );

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w2",
    });
    expect(
      outcomeText(await ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_redo");
  });

  it("validates ranges and unknown handles without crashing", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Alpha." });
    await scenario.ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      context,
    );

    const inverted = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w1" },
      context,
    );
    expectOutcome(inverted, "invalid_write", true);
    expect(outcomeText(inverted)).toContain("from must be before or equal to to");
    expect(
      outcomeText(
        await scenario.ctx.core.write({ command: "undo", file: "chapter.md", to: "w99" }, context),
      ),
    ).toBe("status: nothing_to_undo");
    expect(
      outcomeText(
        await scenario.ctx.core.write({ command: "redo", file: "chapter.md", to: "w99" }, context),
      ),
    ).toBe("status: nothing_to_redo");
  });

  it("treats cold undo target drift as a non-retained write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const invariantMessages: string[] = [];
    await scenario.simpleReplace("turn-cold-undo-drift");
    const driftCore = createAgentEditCore({
      journal: journalWithMissingMutationTarget(scenario.ctx.journal, {
        writeId: "w1",
        status: "active",
        createdSeq: 999,
      }),
      coordinator: scenario.ctx.coordinator,
      lifecycle: scenario.ctx.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
      onInvariantViolation: (message) => invariantMessages.push(message),
    });

    const undo = await driftCore.undoTurn("chapter.md", THREAD_ID);

    expectOutcome(undo, "nothing_to_undo");
    expect(outcomeText(undo)).toBe("status: nothing_to_undo");
    expect(invariantMessages).toEqual([]);
    expect(await scenario.ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toEqual(
      [],
    );
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "active" }]);
  });

  it("treats cold redo target drift as a non-retained write", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    const invariantMessages: string[] = [];
    await scenario.simpleReplace("turn-cold-redo-drift");
    await scenario.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const [reversal] = await scenario.ctx.journal.readReversals("chapter.md", {
      threadId: THREAD_ID,
      status: ["reversed"],
    });
    const undoUpdateSeq = reversal?.undoUpdateSeq;
    if (undoUpdateSeq === undefined) throw new Error("expected undo update seq");
    const driftCore = createAgentEditCore({
      journal: journalWithMissingMutationTarget(scenario.ctx.journal, {
        writeId: "w1",
        status: "reversed",
        createdSeq: 999,
        undoUpdateSeq,
      }),
      coordinator: scenario.ctx.coordinator,
      lifecycle: scenario.ctx.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
      onInvariantViolation: (message) => invariantMessages.push(message),
    });

    const redo = await driftCore.redoTurn("chapter.md", THREAD_ID);

    expectOutcome(redo, "nothing_to_redo");
    expect(outcomeText(redo)).toBe("status: nothing_to_redo");
    expect(invariantMessages).toEqual([]);
    expect(await scenario.mutationsFor("w1")).toMatchObject([{ status: "reversed" }]);
  });

  it("reports undo availability only while active mutation updates are retained", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Alpha sword." });
    await scenario.simpleReplace("turn-availability");

    expect(await scenario.ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w1",
    });

    await scenario.ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));

    expect(await scenario.ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: false,
    });
    expect(
      outcomeText(await scenario.ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_undo");
  });

  it("reports redo unavailable when compaction drops retained reversal rows", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Alpha sword waits." });
    await scenario.simpleReplace("turn-redo-compacted-prefix");
    const stateAfterForwardWrite = Y.encodeStateAsUpdate(scenario.ctx.liveDoc("chapter.md"));
    await scenario.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(await scenario.ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoWriteId: "w1",
    });

    await scenario.ctx.journal.checkpoint("chapter.md", stateAfterForwardWrite, 1);
    await scenario.ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));

    expect((await scenario.ctx.journal.read("chapter.md")).updates).toEqual([]);
    expect(await scenario.ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: false,
    });
    expect(
      outcomeText(await scenario.ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_redo");
  });

  it("exposes user turn undo and redo seams by document and thread", async () => {
    const scenario = await ReversalScenario.read(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await scenario.simpleReplace("turn-user-seam");

    const undo = await scenario.ctx.core.undoTurn("chapter.md", THREAD_ID);
    expect(outcomeText(undo)).toContain("status: reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha sword."]);

    const redo = await scenario.ctx.core.redoTurn("chapter.md", THREAD_ID);
    expect(outcomeText(redo)).toContain("status: reconciled");
    expect(scenario.blockTexts()).toEqual(["Alpha blade."]);
  });

  it("cold undo filters interleaved journal targets by thread", async () => {
    const threadB = "thread-b";
    const contextB = { sessionId: "session-b", threadId: threadB };
    const scenario = ReversalScenario.raw({
      "chapter.md": "Paragraph 1 original.\n\nParagraph 2 original.\n\nParagraph 3 original.",
    });
    const { ctx } = scenario;

    await ctx.core.write({ command: "read", file: "chapter.md" }, contextB);
    await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Thread B paragraph 2.",
        find: "Paragraph 2 original.",
      },
      { ...contextB, turnId: "turn-b-1" },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Thread A paragraph 1.",
        find: "Paragraph 1 original.",
      },
      { ...context, turnId: "turn-a" },
    );
    await ctx.core.write({ command: "read", file: "chapter.md" }, contextB);
    await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Thread B paragraph 3.",
        find: "Paragraph 3 original.",
      },
      { ...contextB, turnId: "turn-b-2" },
    );

    const undo = await ctx.core.undoTurn("chapter.md", threadB);

    expectOutcome(undo, "reconciled");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Thread A paragraph 1.",
      "Thread B paragraph 2.",
      "Paragraph 3 original.",
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", threadB, "w2")).toMatchObject([
      { createdSeq: 3, status: "reversed", undoUpdateSeq: expect.any(Number) },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { createdSeq: 2, status: "active" },
    ]);
  });
});
