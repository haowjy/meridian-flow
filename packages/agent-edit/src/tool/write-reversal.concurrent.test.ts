// Repros for concurrent human edits interleaved with write-level undo/redo cycles.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { blockTexts } from "./test-support/assertions.js";
import { ReversalScenario } from "./test-support/write-reversal-scenario.js";
import { cloneDoc, context, model, THREAD_ID } from "./test-support/write-tool-harness.js";

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

    const beforeFinalUndo = blockTexts(scenario.ctx.liveDoc("chapter.md"));
    const undoW1 = await scenario.ctx.core.reverse({
      docId: "chapter.md",
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "single", to: "w1" },
      actor,
    });

    expect(undoW1.status).toBe("cant_undo_dependent");
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md"))).toEqual(beforeFinalUndo);
    expect(blockTexts(scenario.ctx.liveDoc("chapter.md")).join("\n")).not.toMatch(
      /swordsword|shieldshield/,
    );
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
