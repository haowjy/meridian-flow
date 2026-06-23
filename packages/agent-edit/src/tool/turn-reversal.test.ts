// Turn-level undo/redo, availability, durable status, and response formatting contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import type { TurnMutationRow, UpdateJournal } from "../ports/update-journal.js";
import { createUndoManagerRegistry } from "../undo/manager-registry.js";
import {
  blockTexts,
  expectNoInternalIds,
  expectOutcome,
  hashAt,
  humanText,
  outcomeText,
} from "./test-support/assertions.js";
import type { MemoryJournal } from "./test-support/recording-journal.js";
import {
  codec,
  context,
  harness,
  model,
  REVERSAL_CLIENT_ID,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";
import type { WriteOutcome } from "./types.js";

describe("turn reversal", () => {
  it("flips mutation status when undoing and redoing a turn", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-mutation-status" },
    );

    expect(
      await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, "turn-mutation-status"),
    ).toMatchObject([{ status: "active", createdSeq: 1 }]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(outcomeText(undo)).toContain("status: reversed");
    const [reversal] = await ctx.journal.readReversals("chapter.md", {
      threadId: THREAD_ID,
      status: ["reversed"],
    });
    expect(reversal).toMatchObject({
      turnId: "turn-mutation-status",
      threadId: THREAD_ID,
      status: "reversed",
    });
    expect(reversal?.undoUpdateSeq).toBeGreaterThan(0);
    expect(
      await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, "turn-mutation-status"),
    ).toMatchObject([{ status: "reversed", undoUpdateSeq: reversal?.undoUpdateSeq }]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toContain("status: reversed");
    const [afterRedo] = await ctx.journal.mutationsForTurn(
      "chapter.md",
      THREAD_ID,
      "turn-mutation-status",
    );
    expect(afterRedo).toMatchObject({ status: "active" });
    expect(afterRedo?.undoUpdateSeq).toBeUndefined();
    expect(await ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toMatchObject([
      { turnId: "turn-mutation-status", status: "redone" },
    ]);
  });

  it("scopes same-turn mutation status flips to the reversal being redone", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    const turnContext = { ...context, turnId: "turn-interleaved-status" };
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
      turnContext,
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const [firstMutation] = await ctx.journal.mutationsForTurn(
      "chapter.md",
      THREAD_ID,
      "turn-interleaved-status",
    );
    const firstUndoSeq = firstMutation?.undoUpdateSeq;
    expect(firstMutation).toMatchObject({
      status: "reversed",
      undoUpdateSeq: expect.any(Number),
    });

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      turnContext,
    );
    expect(
      await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, "turn-interleaved-status"),
    ).toMatchObject([{ status: "reversed", undoUpdateSeq: firstUndoSeq }, { status: "active" }]);

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const afterSecondUndo = await ctx.journal.mutationsForTurn(
      "chapter.md",
      THREAD_ID,
      "turn-interleaved-status",
    );
    const secondUndoSeq = afterSecondUndo[1]?.undoUpdateSeq;
    expect(afterSecondUndo).toMatchObject([
      { status: "reversed", undoUpdateSeq: firstUndoSeq },
      { status: "reversed", undoUpdateSeq: expect.any(Number) },
    ]);
    expect(secondUndoSeq).not.toBe(firstUndoSeq);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoTurnId: "turn-interleaved-status",
    });

    await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    const afterRedo = await ctx.journal.mutationsForTurn(
      "chapter.md",
      THREAD_ID,
      "turn-interleaved-status",
    );
    expect(afterRedo).toMatchObject([
      { status: "reversed", undoUpdateSeq: firstUndoSeq },
      { status: "active" },
    ]);
    expect(afterRedo[1]?.undoUpdateSeq).toBeUndefined();
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-interleaved-status",
    });
  });

  it("cold undo reverses only the active subset inside a reused turn id", async () => {
    const turnId = "turn-cold-active-subset";

    async function setup(ctx: ReturnType<typeof harness>) {
      const turnContext = { ...context, turnId };
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
        turnContext,
      );
      expect(
        outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
      ).toContain("status: reversed");
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        turnContext,
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
      expect(await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, turnId)).toMatchObject([
        { status: "reversed" },
        { status: "active", createdSeq: 3 },
      ]);
    }

    const hot = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(hot);
    const hotUndo = await hot.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(hotUndo)).toContain("status: reversed");

    const cold = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(cold);
    const coldUndo = await cold.core.undoTurn("chapter.md", THREAD_ID);
    expect(outcomeText(coldUndo)).toContain("status: reversed");

    expect(blockTexts(hot.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
    expect(blockTexts(cold.liveDoc("chapter.md"))).toEqual(blockTexts(hot.liveDoc("chapter.md")));
    expect(await cold.journal.mutationsForTurn("chapter.md", THREAD_ID, turnId)).toMatchObject([
      { status: "reversed" },
      { status: "reversed" },
    ]);
  });

  it("cold redo replays the most recent reversed subset inside a reused turn id", async () => {
    const turnId = "turn-cold-redo-subset";

    async function setup(ctx: ReturnType<typeof harness>) {
      const turnContext = { ...context, turnId };
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
        turnContext,
      );
      await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        turnContext,
      );
      await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
      const rows = await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, turnId);
      expect(rows).toMatchObject([
        { status: "reversed", undoUpdateSeq: expect.any(Number) },
        { status: "reversed", undoUpdateSeq: expect.any(Number) },
      ]);
      expect(rows[1]?.undoUpdateSeq).not.toBe(rows[0]?.undoUpdateSeq);
    }

    const hot = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(hot);
    const hotRedo = await hot.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(hotRedo)).toContain("status: reversed");

    const cold = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await setup(cold);
    const coldRedo = await cold.core.redoTurn("chapter.md", THREAD_ID);
    expect(outcomeText(coldRedo)).toContain("status: reversed");

    expect(blockTexts(hot.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
    expect(blockTexts(cold.liveDoc("chapter.md"))).toEqual(blockTexts(hot.liveDoc("chapter.md")));
    const coldRows = await cold.journal.mutationsForTurn("chapter.md", THREAD_ID, turnId);
    expect(coldRows).toMatchObject([{ status: "reversed" }, { status: "active" }]);
    expect(coldRows[1]?.undoUpdateSeq).toBeUndefined();
  });

  it("surfaces cold undo target drift as an internal error instead of a false no-op", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    const invariantMessages: string[] = [];
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-cold-undo-drift" },
    );
    const driftCore = createAgentEditCore({
      journal: journalWithMissingMutationTarget(ctx.journal, {
        status: "active",
        createdSeq: 999,
      }),
      coordinator: ctx.coordinator,
      lifecycle: ctx.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
      onInvariantViolation: (message) => {
        invariantMessages.push(message);
      },
    });

    const undo = await driftCore.undoTurn("chapter.md", THREAD_ID);

    expectOutcome(undo, "internal_error", true);
    expect(outcomeText(undo)).toContain("Cold undo reconstruction invariant failed");
    expect(outcomeText(undo)).toContain("Missing target update seqs");
    expect(outcomeText(undo)).not.toBe("status: nothing_to_undo");
    expect(invariantMessages).toHaveLength(1);
    expect(invariantMessages[0]).toContain("turn-cold-undo-drift");
    expect(await ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toEqual([]);
    expect(
      await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, "turn-cold-undo-drift"),
    ).toMatchObject([{ status: "active" }]);
  });

  it("surfaces cold redo target drift as an internal error instead of a false no-op", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    const invariantMessages: string[] = [];
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-cold-redo-drift" },
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const [reversal] = await ctx.journal.readReversals("chapter.md", {
      threadId: THREAD_ID,
      status: ["reversed"],
    });
    const undoUpdateSeq = reversal?.undoUpdateSeq;
    if (undoUpdateSeq === undefined) throw new Error("expected undo update seq");
    const driftCore = createAgentEditCore({
      journal: journalWithMissingMutationTarget(ctx.journal, {
        status: "reversed",
        createdSeq: 999,
        undoUpdateSeq,
      }),
      coordinator: ctx.coordinator,
      lifecycle: ctx.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
      onInvariantViolation: (message) => {
        invariantMessages.push(message);
      },
    });

    const redo = await driftCore.redoTurn("chapter.md", THREAD_ID);

    expectOutcome(redo, "internal_error", true);
    expect(outcomeText(redo)).toContain("Cold redo reconstruction invariant failed");
    expect(outcomeText(redo)).toContain("Missing target update seqs");
    expect(outcomeText(redo)).not.toBe("status: nothing_to_redo");
    expect(invariantMessages).toHaveLength(1);
    expect(invariantMessages[0]).toContain("turn-cold-redo-drift");
    expect(
      await ctx.journal.mutationsForTurn("chapter.md", THREAD_ID, "turn-cold-redo-drift"),
    ).toMatchObject([{ status: "reversed" }]);
    expect(
      await ctx.journal.readReversals("chapter.md", {
        threadId: THREAD_ID,
        status: ["reversed"],
      }),
    ).toMatchObject([{ undoUpdateSeq }]);
  });

  it("reports undo availability only while active mutation updates are retained", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-availability" },
    );

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-availability",
    });

    await ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: false,
    });
    expect(
      outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_undo");
  });

  it("reports redo availability through the existing linear redo eligibility rule", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-redo-availability" },
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoTurnId: "turn-redo-availability",
    });

    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "New forward edit." },
      { ...context, turnId: "turn-after-undo" },
    );

    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoTurnId: "turn-after-undo",
    });
    expect(
      outcomeText(await ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_redo");
  });

  it("reports redo unavailable when partial compaction drops the reversed turn start", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const turnContext = { ...context, turnId: "turn-redo-compacted-prefix" };

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha" },
      turnContext,
    );
    const stateAfterFirstForwardWrite = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      turnContext,
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoTurnId: "turn-redo-compacted-prefix",
    });

    await ctx.journal.checkpoint("chapter.md", stateAfterFirstForwardWrite, 1);

    expect((await ctx.journal.read("chapter.md")).updates.map((update) => update.seq)).toEqual([
      2, 3,
    ]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: false,
    });
    expect(
      outcomeText(await ctx.core.write({ command: "redo", file: "chapter.md" }, context)),
    ).toBe("status: nothing_to_redo");
  });

  const noInternalIdCases: NoInternalIdCase[] = [
    {
      label: "full undo",
      setup: () => deletedBlockScenario("turn-response-format-undo"),
      run: ({ ctx }) => ctx.core.write({ command: "undo", file: "chapter.md" }, context),
      assertExtra: ({ originalHash }, text) => {
        const lines = text.split("\n");
        expect(lines.slice(0, 4)).toEqual(["status: reversed", "", "undo: 1 edit(s)", ""]);
        expect(lines[4]).toMatch(/^[0-9a-f]{4}\|Beta waits in the clearing, sword drawn\.$/);
        expect(lines[4]?.split("|")[0]).not.toBe(originalHash);
      },
    },
    {
      label: "full redo",
      setup: async () => {
        const state = await deletedBlockScenario("turn-response-format-redo");
        await state.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
        return state;
      },
      run: ({ ctx }) => ctx.core.write({ command: "redo", file: "chapter.md" }, context),
      assertExtra: (_state, text) => {
        expect(text.split("\n").slice(0, 4)).toEqual([
          "status: reversed",
          "",
          "redo: 1 edit(s)",
          "",
        ]);
      },
    },
    {
      label: "partial undo",
      setup: () => simpleReplaceScenario("turn-partial-format-undo"),
      run: ({ ctx }) => ctx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context),
      assertExtra: (_state, text) => {
        expect(text).toContain("status: partial");
        expect(text).toContain("undo: 1 edit(s)");
      },
    },
    {
      label: "partial redo",
      setup: async () => {
        const state = await simpleReplaceScenario("turn-partial-format-redo");
        await state.ctx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context);
        return state;
      },
      run: ({ ctx }) => ctx.core.write({ command: "redo", file: "chapter.md", last: 2 }, context),
      assertExtra: (_state, text) => {
        expect(text).toContain("status: partial");
        expect(text).toContain("redo: 1 edit(s)");
      },
    },
    {
      label: "expired redo",
      setup: async () => {
        const state = await simpleReplaceScenario("turn-expired-format", {
          retention: { reversalWindowMs: -1 },
        });
        await state.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
        return state;
      },
      run: ({ ctx }) => ctx.core.write({ command: "redo", file: "chapter.md" }, context),
      assertExtra: (_state, text) => {
        expect(text).toBe("status: nothing_to_redo");
      },
    },
    {
      label: "reconciled undo",
      setup: async () => {
        const state = await simpleReplaceScenario("turn-reconciled-undo");
        humanText(state.ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");
        return state;
      },
      run: ({ ctx }) => ctx.core.write({ command: "undo", file: "chapter.md" }, context),
      assertExtra: ({ ctx }, text) => {
        expect(text).toContain("status: reconciled");
        expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha sword."]);
      },
    },
    {
      label: "reconciled redo",
      setup: async () => {
        const state = await simpleReplaceScenario("turn-reconciled-redo");
        await state.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
        humanText(state.ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");
        return state;
      },
      run: ({ ctx }) => ctx.core.write({ command: "redo", file: "chapter.md" }, context),
      assertExtra: ({ ctx }, text) => {
        expect(text).toContain("status: reconciled");
        expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha blade."]);
      },
    },
    {
      label: "multi-write same turn",
      setup: async () => {
        const ctx = harness({ "chapter.md": "Alpha sword.\n\nOmega." });
        const turnContext = { ...context, turnId: "turn-with-two-writes" };
        await ctx.core.write({ command: "view", file: "chapter.md" }, context);
        const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);
        await ctx.core.write(
          { command: "insert", file: "chapter.md", content: "Inserted.", after: alphaHash },
          turnContext,
        );
        await ctx.core.write(
          { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
          turnContext,
        );
        return { ctx };
      },
      run: ({ ctx }) => ctx.core.write({ command: "undo", file: "chapter.md" }, context),
      assertExtra: ({ ctx }, text) => {
        expect(text).toContain("status: reversed");
        expect(text).toContain("undo: 1 edit(s)");
        expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword.", "Omega."]);
      },
    },
  ];

  it.each(noInternalIdCases)("does not leak internal ids in $label", async ({
    setup,
    run,
    assertExtra,
  }) => {
    const state = await setup();
    const output = await run(state);
    const text = outcomeText(output);

    expectNoInternalIds(text);
    await assertExtra?.(state, text);
  });

  it("exposes user turn undo and redo seams by document and thread", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-user-seam" },
    );

    const undo = await ctx.core.undoTurn("chapter.md", THREAD_ID);

    expect(outcomeText(undo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

    const redo = await ctx.core.redoTurn("chapter.md", THREAD_ID);

    expect(outcomeText(redo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("undoes and redoes this thread's writes", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(undo)).toContain("status: reversed");
    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("status: reversed");
    expectOutcome(redo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("undoes every separate write call in one turn on hot and cold paths", async () => {
    async function run(ctx: ReturnType<typeof harness>) {
      const turnContext = { ...context, turnId: "turn-with-two-writes" };
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);

      await ctx.core.write(
        { command: "insert", file: "chapter.md", content: "Inserted.", after: alphaHash },
        turnContext,
      );
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        turnContext,
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
        "Alpha blade.",
        "Inserted.",
        "Omega.",
      ]);

      const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      const undoText = outcomeText(undo);

      expect(undoText).toContain("status: reversed");
      expect(undoText).toContain("undo: 1 edit(s)");
      return blockTexts(ctx.liveDoc("chapter.md"));
    }

    const hot = await run(harness({ "chapter.md": "Alpha sword.\n\nOmega." }));
    const cold = await run(
      harness(
        { "chapter.md": "Alpha sword.\n\nOmega." },
        { undoRegistry: createUndoManagerRegistry({ undoDepthCap: 0 }) },
      ),
    );

    expect(hot).toEqual(["Alpha sword.", "Omega."]);
    expect(cold).toEqual(hot);
  });
});

type NoInternalIdState = {
  ctx: ReturnType<typeof harness>;
  originalHash?: string;
};

type NoInternalIdCase = {
  label: string;
  setup: () => Promise<NoInternalIdState>;
  run: (state: NoInternalIdState) => Promise<string | WriteOutcome>;
  assertExtra?: (state: NoInternalIdState, text: string) => void | Promise<void>;
};

async function deletedBlockScenario(turnId: string): Promise<NoInternalIdState> {
  const ctx = harness({
    "chapter.md": "Beta waits in the clearing, sword drawn.\n\nThe wind carries the scent of rain.",
  });
  await ctx.core.write({ command: "view", file: "chapter.md" }, context);
  const originalHash = hashAt(ctx.liveDoc("chapter.md"), 0);

  await ctx.core.write(
    { command: "replace", file: `chapter.md#${originalHash}`, content: "" },
    { ...context, turnId },
  );

  return { ctx, originalHash };
}

async function simpleReplaceScenario(
  turnId: string,
  options?: Parameters<typeof harness>[1],
): Promise<NoInternalIdState> {
  const ctx = harness({ "chapter.md": "Alpha sword." }, options);
  await ctx.core.write({ command: "view", file: "chapter.md" }, context);
  await ctx.core.write(
    { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
    { ...context, turnId },
  );
  return { ctx };
}

function journalWithMissingMutationTarget(
  journal: MemoryJournal,
  missing: Pick<TurnMutationRow, "status" | "createdSeq" | "undoUpdateSeq">,
): UpdateJournal {
  return {
    append: journal.append.bind(journal),
    appendBatch: journal.appendBatch.bind(journal),
    latestActiveTurn: journal.latestActiveTurn.bind(journal),
    activeTurnSummary: journal.activeTurnSummary.bind(journal),
    turnMinCreatedSeq: journal.turnMinCreatedSeq.bind(journal),
    mutationsForTurn: async (documentId, threadId, turnId) => {
      const rows = await journal.mutationsForTurn(documentId, threadId, turnId);
      return [
        ...rows,
        {
          wId: 999,
          createdSeq: missing.createdSeq,
          status: missing.status,
          ...(missing.undoUpdateSeq !== undefined ? { undoUpdateSeq: missing.undoUpdateSeq } : {}),
        },
      ];
    },
    read: journal.read.bind(journal),
    checkpoint: journal.checkpoint.bind(journal),
    compact: journal.compact.bind(journal),
    persistReversal: journal.persistReversal.bind(journal),
    persistRedo: journal.persistRedo.bind(journal),
    readReversals: journal.readReversals.bind(journal),
  };
}
