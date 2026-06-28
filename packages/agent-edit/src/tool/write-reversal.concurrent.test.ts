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

  it("keeps a human insertion before the agent replacement at the same text boundary", async () => {
    const scenario = await ReversalScenario.read({
      "chapter.md": "Beta shield.",
    });
    await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", find: "shield", content: "ward" },
      { ...context, turnId: "turn-human-before-replacement" },
    );

    await applyRemoteHumanEdit(
      scenario.ctx.liveDoc("chapter.md"),
      scenario.ctx.journal,
      (remote) => {
        const block = model.getBlocks(remote)[0];
        if (!block) throw new Error("expected first block");
        model.applyTextEdit(remote, block, { from: "Beta ".length, to: "Beta ".length }, "bright ");
      },
    );

    const undo = await scenario.ctx.core.write(
      { command: "undo", file: "chapter.md", all: true },
      context,
    );

    expect(undo.status).toBe("reconciled");
    expect(scenario.blockTexts()).toEqual(["Beta bright shield."]);
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

  it("expands one grouped redo boundary after a multi-cycle runtime replay", async () => {
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

async function groupedRedoScenario(): Promise<ReversalScenario> {
  const scenario = await ReversalScenario.read({
    "chapter.md": "Alpha sword.\n\nBeta shield.\n\nGamma cloak.",
  });
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
