// Repros for concurrent human edits interleaved with write-level undo/redo cycles.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { blockTexts, expectOutcome, outcomeText } from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import {
  cloneDoc,
  context,
  model,
  REVERSAL_CLIENT_ID,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

const actor = { type: "user", userId: "user-1" } as const;

type StepState = {
  step: string;
  status: string;
  blocks: string[];
  mutationStatus: string;
  undoUpdateSeq?: number;
  reversalStatus?: string;
};

describe("write reversal under concurrent edits", () => {
  it("preserves an unrelated block interleaved into undo → redo → undo", async () => {
    // Observed on 2026-06-27 after 26aae187:
    //   undo   => reconciled, ["Agent target.", "Human target. Human edit."]
    //   redo   => reconciled, ["Agent revised.", "Human target. Human edit."]
    //   undo-2 => reconciled, ["Agent target.Agent target.", "Human target. Human edit."]
    //   redo-2 => reconciled, ["Agent target..", "Human target. Human edit."]
    //
    // Pre-26aae187 the second undo stopped earlier with cant_undo_dependent /
    // nothing_to_redo. The repeatable-cycle fix removed that refusal, but the
    // reconstructed second undo/redo is now corrupt when a human seq interleaves.
    const scenario = await ReversalScenario.read({
      "chapter.md": "Agent target.\n\nHuman target.",
    });
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Agent target.", content: "Agent revised." },
      { ...context, turnId: "turn-concurrent-different-block" },
    );

    await applyRemoteHumanEdit(
      scenario.ctx.liveDoc("chapter.md"),
      scenario.ctx.journal,
      (remote) => {
        const block = model.getBlocks(remote)[1];
        if (!block) throw new Error("expected second block");
        model.applyTextEdit(
          remote,
          block,
          { from: "Human target.".length, to: "Human target.".length },
          " Human edit.",
        );
      },
    );

    const states = await collectCycleStates(scenario, "w1");

    expect(
      states.map(({ step, status, blocks, mutationStatus }) => ({
        step,
        status,
        blocks,
        mutationStatus,
      })),
    ).toEqual([
      {
        step: "undo",
        status: "reconciled",
        blocks: ["Agent target.", "Human target. Human edit."],
        mutationStatus: "reversed",
      },
      {
        step: "redo",
        status: "reconciled",
        blocks: ["Agent revised.", "Human target. Human edit."],
        mutationStatus: "active",
      },
      {
        step: "undo-2",
        status: "reconciled",
        blocks: ["Agent target.", "Human target. Human edit."],
        mutationStatus: "reversed",
      },
      {
        step: "redo-2",
        status: "reconciled",
        blocks: ["Agent revised.", "Human target. Human edit."],
        mutationStatus: "active",
      },
    ]);
  });

  it("preserves same-block different-range edits interleaved into a repeatable cycle", async () => {
    // Observed on 2026-06-27 after 26aae187:
    //   undo   => reconciled, ["Alpha sword and ward."]
    //   redo   => reconciled, ["Alpha blade and ward."]
    //   undo-2 => reconciled, ["Alpha swordsword and ward."]
    //   redo-2 => reconciled, ["Alpha sword and ward."]
    //
    // Pre-26aae187 the second undo refused with cant_undo_dependent. After the
    // redo re-apply heuristic landed, the second undo proceeds but duplicates the
    // reverted range.
    const scenario = await ReversalScenario.read({
      "chapter.md": "Alpha sword and shield.",
    });
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      { ...context, turnId: "turn-concurrent-same-block" },
    );

    await applyRemoteHumanEdit(
      scenario.ctx.liveDoc("chapter.md"),
      scenario.ctx.journal,
      (remote) => {
        const block = model.getBlocks(remote)[0];
        if (!block) throw new Error("expected first block");
        const text = model.getText(block);
        const from = text.indexOf("shield");
        model.applyTextEdit(remote, block, { from, to: from + "shield".length }, "ward");
      },
    );

    const states = await collectCycleStates(scenario, "w1");

    expect(
      states.map(({ step, status, blocks, mutationStatus }) => ({
        step,
        status,
        blocks,
        mutationStatus,
      })),
    ).toEqual([
      {
        step: "undo",
        status: "reconciled",
        blocks: ["Alpha sword and ward."],
        mutationStatus: "reversed",
      },
      {
        step: "redo",
        status: "reconciled",
        blocks: ["Alpha blade and ward."],
        mutationStatus: "active",
      },
      {
        step: "undo-2",
        status: "reconciled",
        blocks: ["Alpha sword and ward."],
        mutationStatus: "reversed",
      },
      {
        step: "redo-2",
        status: "reconciled",
        blocks: ["Alpha blade and ward."],
        mutationStatus: "active",
      },
    ]);
  });

  it("keeps a multi-cycle undo/redo/undo/redo/undo correct with a foreign edit", async () => {
    const scenario = await ReversalScenario.read({
      "chapter.md": "Agent target.\n\nHuman target.",
    });
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "Agent target.", content: "Agent revised." },
      { ...context, turnId: "turn-concurrent-multi-cycle" },
    );

    await applyRemoteHumanEdit(
      scenario.ctx.liveDoc("chapter.md"),
      scenario.ctx.journal,
      (remote) => {
        const block = model.getBlocks(remote)[1];
        if (!block) throw new Error("expected second block");
        model.applyTextEdit(
          remote,
          block,
          { from: "Human target.".length, to: "Human target.".length },
          " Human edit.",
        );
      },
    );

    const states = await collectCycleStates(scenario, "w1", [
      "undo",
      "redo",
      "undo",
      "redo",
      "undo",
    ]);

    expect(
      states.map(({ step, status, blocks, mutationStatus }) => ({
        step,
        status,
        blocks,
        mutationStatus,
      })),
    ).toEqual([
      {
        step: "undo",
        status: "reconciled",
        blocks: ["Agent target.", "Human target. Human edit."],
        mutationStatus: "reversed",
      },
      {
        step: "redo",
        status: "reconciled",
        blocks: ["Agent revised.", "Human target. Human edit."],
        mutationStatus: "active",
      },
      {
        step: "undo-2",
        status: "reconciled",
        blocks: ["Agent target.", "Human target. Human edit."],
        mutationStatus: "reversed",
      },
      {
        step: "redo-2",
        status: "reconciled",
        blocks: ["Agent revised.", "Human target. Human edit."],
        mutationStatus: "active",
      },
      {
        step: "undo-3",
        status: "reconciled",
        blocks: ["Agent target.", "Human target. Human edit."],
        mutationStatus: "reversed",
      },
    ]);
  });

  it("refuses p1393 foreign system lineage after undo all → redo → undo w2", async () => {
    const scenario = await ReversalScenario.read({
      "chapter.md": "Alpha sword.\n\nBeta shield.",
    });
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      { ...context, turnId: "turn-p1393-w1" },
    );
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "shield", content: "ward" },
      { ...context, turnId: "turn-p1393-w2" },
    );

    const undoAll = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "all" },
      actor,
    });
    const redo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "all" },
      actor,
    });
    const undoW2 = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "single", to: "w2" },
      actor,
    });
    expect({
      undoAll: undoAll.status,
      redo: redo.status,
      undoW2: undoW2.status,
    }).toEqual({
      undoAll: "reconciled",
      redo: "reconciled",
      undoW2: "reconciled",
    });
    expect(undoW2.text).toContain("undo: 2 edit(s)");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha sword.",
      "Beta shield.",
    ]);
    await expectMutationStatuses(scenario, { w1: "reversed", w2: "reversed" });
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md")).join("\n")).not.toMatch(
      /swordsword|shieldshield/,
    );
  });

  it("expands sword→blade→saber when undo hits its grouped redo boundary", async () => {
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

  it("still refuses a non-grouped dependent write", async () => {
    const scenario = await ReversalScenario.read({ "chapter.md": "Alpha sword." });
    await scenario.writeDependentSwordSaber();

    const undoEarlier = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", to: "w1" },
      context,
    );

    expectOutcome(undoEarlier, "cant_undo_dependent", true);
    expect(outcomeText(undoEarlier)).toContain("w2 was built on it");
    expect(scenario.blockTexts()).toEqual(["Alpha saber."]);
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

  it("expands a grouped redo boundary when undo latest hits one handle", async () => {
    const scenario = await groupedRedoScenario();

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });

    expect(undo.status).toBe("reconciled");
    expect(undo.text).toContain("undo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta shield.", "Gamma cloak."]);
    await expectMutationStatuses(scenario, {
      w1: "reversed",
      w2: "reversed",
      w3: "reversed",
    });
  });

  it("expands a grouped redo boundary when undoing a single selected handle", async () => {
    const scenario = await groupedRedoScenario();

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "single", to: "w1" },
      actor,
    });

    expect(undo.status).toBe("reconciled");
    expect(undo.text).toContain("undo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta shield.", "Gamma cloak."]);
    await expectMutationStatuses(scenario, {
      w1: "reversed",
      w2: "reversed",
      w3: "reversed",
    });
  });

  it("expands a grouped redo boundary when undoing a selected range", async () => {
    const scenario = await groupedRedoScenario();

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "range", from: "w1", to: "w2" },
      actor,
    });

    expect(undo.status).toBe("reconciled");
    expect(undo.text).toContain("undo: 3 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta shield.", "Gamma cloak."]);
    await expectMutationStatuses(scenario, {
      w1: "reversed",
      w2: "reversed",
      w3: "reversed",
    });
  });

  it("expands a turn-scoped undo to the shared redo boundary instead of persisting a partial reversal", async () => {
    const scenario = await twoTurnInsertScenario();
    await undoRangeAndRedoAll(scenario);

    const undoTurnB = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-b" },
      actor,
    });

    expect(["reconciled", "reversed"]).toContain(undoTurnB.status);
    expect(undoTurnB.text).toContain("undo: 2 edit(s)");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
    await expectMutationStatuses(scenario, {
      w1: "reversed",
      w2: "reversed",
    });
  });

  it("keeps whole-scope undo consistent after a grouped redo", async () => {
    const scenario = await twoTurnInsertScenario();
    await undoRangeAndRedoAll(scenario);

    const undoAll = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "all" },
      actor,
    });

    expect(["reconciled", "reversed"]).toContain(undoAll.status);
    expect(undoAll.text).toContain("undo: 2 edit(s)");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
    await expectMutationStatuses(scenario, {
      w1: "reversed",
      w2: "reversed",
    });
  });

  it("keeps turn-scoped undo narrow when writes were redone in separate redo operations", async () => {
    const scenario = await twoTurnInsertScenario();
    await expectUndoRedoStatus(scenario, "undo", { kind: "single", to: "w2" });
    await expectUndoRedoStatus(scenario, "undo", { kind: "single", to: "w1" });
    await expectUndoRedoStatus(scenario, "redo", { kind: "single", to: "w1" });
    await expectUndoRedoStatus(scenario, "redo", { kind: "single", to: "w2" });
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Two."]);

    const undoTurnB = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-b" },
      actor,
    });

    expect(["reconciled", "reversed"]).toContain(undoTurnB.status);
    expect(undoTurnB.text).toContain("undo: 1 edit(s)");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
    await expectMutationStatuses(scenario, {
      w1: "active",
      w2: "reversed",
    });
  });

  it("expands a turn-scoped redo to the shared undo boundary instead of leaving a partial redo", async () => {
    const scenario = await twoTurnInsertScenario();
    const undoRange = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "range", from: "w1", to: "w2" },
      actor,
    });
    expect(["reconciled", "reversed"]).toContain(undoRange.status);
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
    await expectMutationStatuses(scenario, {
      w1: "reversed",
      w2: "reversed",
    });

    const redoTurnB = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "redo",
      selection: { kind: "turn", turnId: "turn-b" },
      actor,
    });

    expect(redoTurnB.status).toBe("reconciled");
    expect(redoTurnB.text).toContain("redo: 2 edit(s)");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Two."]);
    await expectMutationStatuses(scenario, {
      w1: "active",
      w2: "active",
    });
  });

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

    // Deliberate atomic-boundary expansion: undo all produced one undo update,
    // so redoing any subset of that update honestly redoes the whole boundary.
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

  it("keeps latest undo scoped to one write when no grouped redo boundary exists", async () => {
    const scenario = await independentWriteScenario();

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });

    expect(undo.status).toBe("reconciled");
    expect(undo.text).toContain("undo: 1 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cloak."]);
    await expectMutationStatuses(scenario, {
      w1: "active",
      w2: "active",
      w3: "reversed",
    });
  });

  it("keeps subset undo per-handle after writes are redone by separate redo ops", async () => {
    const scenario = await independentWriteScenario();
    for (const writeId of ["w1", "w2", "w3"]) {
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

    const undo = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor,
    });

    expect(undo.status).toBe("reconciled");
    expect(undo.text).toContain("undo: 1 edit(s)");
    expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cloak."]);
    await expectMutationStatuses(scenario, {
      w1: "active",
      w2: "active",
      w3: "reversed",
    });
  });

  it("refuses an exact same-range concurrent replacement and leaves the human text intact", async () => {
    const scenario = await ReversalScenario.read({
      "chapter.md": "Alpha sword.",
    });
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      { ...context, turnId: "turn-concurrent-same-range" },
    );

    await applyRemoteHumanEdit(
      scenario.ctx.liveDoc("chapter.md"),
      scenario.ctx.journal,
      (remote) => {
        const block = model.getBlocks(remote)[0];
        if (!block) throw new Error("expected first block");
        const text = model.getText(block);
        const from = text.indexOf("blade");
        model.applyTextEdit(remote, block, { from, to: from + "blade".length }, "spear");
      },
    );

    const states = await collectCycleStates(scenario, "w1");

    expect(states).toEqual([
      {
        step: "undo",
        status: "cant_undo_dependent",
        blocks: ["Alpha spear."],
        mutationStatus: "active",
      },
      {
        step: "redo",
        status: "nothing_to_redo",
        blocks: ["Alpha spear."],
        mutationStatus: "active",
      },
      {
        step: "undo-2",
        status: "cant_undo_dependent",
        blocks: ["Alpha spear."],
        mutationStatus: "active",
      },
      {
        step: "redo-2",
        status: "nothing_to_redo",
        blocks: ["Alpha spear."],
        mutationStatus: "active",
      },
    ]);
    expect(await scenario.ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toEqual(
      [],
    );
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

async function groupedRedoScenario(): Promise<ReversalScenario> {
  const scenario = await independentWriteScenario();
  const undoAll = await scenario.ctx.core.reverse({
    docId: "chapter.md",
    threadId: THREAD_ID,
    direction: "undo",
    selection: { kind: "all" },
    actor,
  });
  expect(undoAll.status).toBe("reconciled");
  expect(scenario.blockTexts()).toEqual(["Alpha sword.", "Beta shield.", "Gamma cloak."]);

  const redoAll = await scenario.ctx.core.reverse({
    docId: "chapter.md",
    threadId: THREAD_ID,
    direction: "redo",
    selection: { kind: "all" },
    actor,
  });
  expect(redoAll.status).toBe("reconciled");
  expect(scenario.blockTexts()).toEqual(["Alpha blade.", "Beta ward.", "Gamma cape."]);
  expect(await scenario.ctx.core.getAvailability("chapter.md", THREAD_ID)).toMatchObject({
    undo: true,
    undoWriteId: "w3",
    undoTarget: { writeIds: ["w1", "w2", "w3"] },
  });
  await expectMutationStatuses(scenario, { w1: "active", w2: "active", w3: "active" });
  return scenario;
}

async function twoTurnInsertScenario(): Promise<ReversalScenario> {
  const scenario = await ReversalScenario.read({ "chapter.md": "Base." });
  await scenario.ctx.core.write(
    { command: "insert", file: "chapter.md", content: "One." },
    { ...context, turnId: "turn-a" },
  );
  await scenario.ctx.core.write(
    { command: "insert", file: "chapter.md", content: "Two." },
    { ...context, turnId: "turn-b" },
  );
  expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Two."]);
  await expectMutationStatuses(scenario, {
    w1: "active",
    w2: "active",
  });
  return scenario;
}

async function undoRangeAndRedoAll(scenario: ReversalScenario): Promise<void> {
  await expectUndoRedoStatus(scenario, "undo", { kind: "range", from: "w1", to: "w2" });
  expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
  await expectUndoRedoStatus(scenario, "redo", { kind: "all" });
  expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Two."]);
  await expectMutationStatuses(scenario, {
    w1: "active",
    w2: "active",
  });
}

async function expectUndoRedoStatus(
  scenario: ReversalScenario,
  direction: "undo" | "redo",
  selection:
    | { kind: "single"; to: string }
    | { kind: "range"; from: string; to: string }
    | { kind: "all" },
): Promise<void> {
  const result = await scenario.ctx.core.reverse({
    docId: "chapter.md",
    threadId: THREAD_ID,
    direction,
    selection,
    actor,
  });
  expect(["reconciled", "reversed"]).toContain(result.status);
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

async function applyRemoteHumanEdit(
  live: Y.Doc,
  journal: {
    append: (
      docId: string,
      update: Uint8Array,
      meta: { origin: string; seq: number },
    ) => Promise<number>;
  },
  mutateRemote: (remote: Y.Doc) => void,
): Promise<void> {
  const remote = cloneDoc(live);
  const before = Y.encodeStateVector(remote);
  remote.transact(() => mutateRemote(remote), { type: "human" });
  const update = Y.encodeStateAsUpdate(remote, before);
  Y.applyUpdate(live, update, { type: "human" });
  await journal.append("chapter.md", update, { origin: "human:user-2", seq: 0 });
}

async function collectCycleStates(
  scenario: ReversalScenario,
  writeId: string,
  directions: readonly ("undo" | "redo")[] = ["undo", "redo", "undo", "redo"],
): Promise<StepState[]> {
  const states: StepState[] = [];
  const record = async (step: string, status: string) => {
    const [mutation] = await scenario.mutationsFor(writeId);
    const [reversal] = await scenario.ctx.journal.readReversals("chapter.md", {
      threadId: THREAD_ID,
    });
    states.push({
      step,
      status,
      blocks: blockTexts(scenario.ctx.liveDoc("chapter.md")),
      mutationStatus: mutation?.status ?? "missing",
      ...(mutation?.undoUpdateSeq !== undefined ? { undoUpdateSeq: mutation.undoUpdateSeq } : {}),
      ...(reversal ? { reversalStatus: reversal.status } : {}),
    });
  };

  const counts = { undo: 0, redo: 0 };
  for (const direction of directions) {
    counts[direction] += 1;
    const result = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction,
      selection: { kind: "single", to: writeId },
      actor,
    });
    await record(
      counts[direction] === 1 ? direction : `${direction}-${counts[direction]}`,
      result.status,
    );
  }

  return states;
}
