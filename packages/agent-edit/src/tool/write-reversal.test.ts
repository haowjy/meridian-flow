// Write-level undo/redo, availability, durable status, and response formatting contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import type { ReversalStatus } from "../ports/types.js";
import {
  parseWriteHandle,
  type ReversalStore,
  type UpdateJournal,
  type WriteMutationRow,
} from "../ports/update-journal.js";
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

describe("write reversal", () => {
  it("flips mutation status when undoing and redoing a write", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-mutation-status" },
    );

    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { handle: "w1", turnId: "turn-mutation-status", status: "active", createdSeq: 1 },
    ]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(outcomeText(undo)).toContain("status: reversed");
    const [reversal] = await ctx.journal.readReversals("chapter.md", {
      threadId: THREAD_ID,
      status: ["reversed"],
    });
    expect(reversal).toMatchObject({
      turnId: "turn-mutation-status",
      writeIds: ["w1"],
      threadId: THREAD_ID,
      status: "reversed",
    });
    expect(reversal?.undoUpdateSeq).toBeGreaterThan(0);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "reversed", undoUpdateSeq: reversal?.undoUpdateSeq },
    ]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toContain("status: reversed");
    const [afterRedo] = await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1");
    expect(afterRedo).toMatchObject({ status: "active" });
    expect(afterRedo?.undoUpdateSeq).toBeUndefined();
    expect(await ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toMatchObject([
      { turnId: "turn-mutation-status", writeIds: ["w1"], status: "redone" },
    ]);
  });

  it("defaults to the latest write in a multi-write turn and redoes in stack order", async () => {
    const ctx = harness({ "chapter.md": "Alpha." }, { undoClientId: REVERSAL_CLIENT_ID });
    const turnContext = { ...context, turnId: "turn-with-two-writes" };
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write({ command: "insert", file: "chapter.md", content: "A." }, turnContext);
    const aHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "B.", after: aHash },
      turnContext,
    );

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "A.", "B."]);

    expect(
      outcomeText(await ctx.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("undo: 1 edit(s)");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "A."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "active" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { status: "reversed" },
    ]);

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);

    await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "A."]);
    await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "A.", "B."]);
  });

  it("undoes and redoes a write whose update is hidden by a checkpoint", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta arrives." },
      { ...context, turnId: "turn-checkpointed-write" },
    );

    await checkpointLiveDoc(ctx, "chapter.md", 1);

    expect((await ctx.journal.read("chapter.md")).updates).toEqual([]);
    expect(
      (await ctx.journal.readForReconstruction("chapter.md")).updates.map((update) => update.seq),
    ).toEqual([1]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w1",
    });

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expect(outcomeText(undo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoWriteId: "w1",
    });

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword.", "Beta arrives."]);
  });

  it("undoes a later write first, then a checkpointed earlier write", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta arrives." },
      { ...context, turnId: "turn-checkpointed-first" },
    );
    await checkpointLiveDoc(ctx, "chapter.md", 1);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Gamma follows." },
      { ...context, turnId: "turn-later-write" },
    );

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Alpha sword.",
      "Beta arrives.",
      "Gamma follows.",
    ]);

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword.", "Beta arrives."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { status: "reversed" },
    ]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: true,
      undoWriteId: "w1",
      redoWriteId: "w2",
    });

    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "reversed" },
    ]);
  });

  it("returns write ids in immediate results even when the echo is suppressed", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const write = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );

    expect(write.writeId).toBe("w1");
    expect(outcomeText(write)).toContain("write id: w1");
  });

  it("targets one write without disturbing later writes", async () => {
    const ctx = harness({ "chapter.md": "Base." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["A.", "B.", "C."]);

    await ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base.", "B.", "C."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "reversed" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { status: "active" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w3")).toMatchObject([
      { status: "active" },
    ]);
  });

  it("targets an inclusive write range", async () => {
    const ctx = harness({ "chapter.md": "Base." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["One.", "Two.", "Three.", "Four.", "Five."]);

    const undo = await ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w4" },
      context,
    );

    expect(outcomeText(undo)).toContain("undo: 3 edit(s)");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Five."]);
  });

  it("undo all skips compacted-away writes and reverses the retained subset", async () => {
    const ctx = harness({ "chapter.md": "Base." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["One."]);
    const afterW1 = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", find: "Base" },
      { ...context, turnId: "turn-second" },
    );
    setStoredUpdateTime(ctx.journal, "chapter.md", 1, new Date("2026-01-01T00:00:00.000Z"));
    setStoredUpdateTime(ctx.journal, "chapter.md", 2, new Date("2026-01-03T00:00:00.000Z"));

    await ctx.journal.checkpoint("chapter.md", afterW1, 1);
    await ctx.journal.compact("chapter.md", new Date("2026-01-02T00:00:00.000Z"));

    expect(
      (await ctx.journal.readForReconstruction("chapter.md")).updates.map((row) => row.seq),
    ).toEqual([2]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: true,
      redo: false,
      undoWriteId: "w2",
    });

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", all: true }, context);

    expectOutcome(undo, "reversed");
    expect(outcomeText(undo)).toContain("undo: 1 edit(s)");
    expect(outcomeText(undo)).not.toContain("internal_error");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "active" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { status: "reversed" },
    ]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoWriteId: "w2",
    });
  });

  it("targets write ranges by numeric ordinal past w10", async () => {
    const ctx = harness({ "chapter.md": "Base." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(
      ctx,
      Array.from({ length: 11 }, (_, index) => `Block ${index + 1}.`),
    );

    const undo = await ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w10" },
      context,
    );

    expect(outcomeText(undo)).toContain("undo: 9 edit(s)");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base.", "Block 1.", "Block 11."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w10")).toMatchObject([
      { status: "reversed" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w11")).toMatchObject([
      { status: "active" },
    ]);
  });

  it("compares write handles by numeric ordinal", async () => {
    const handles = ["w1", "w2", "w10", "w11"].sort((left, right) => {
      const leftOrdinal = parseWriteHandle(left) ?? 0;
      const rightOrdinal = parseWriteHandle(right) ?? 0;
      return leftOrdinal - rightOrdinal;
    });

    expect(handles).toEqual(["w1", "w2", "w10", "w11"]);
  });

  it("targets a range across turns", async () => {
    const ctx = harness({ "chapter.md": "Base." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["One.", "Two."], "turn-a");
    await appendBlocks(ctx, ["Three.", "Four."], "turn-b");

    await ctx.core.write({ command: "undo", file: "chapter.md", from: "w2", to: "w3" }, context);

    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Four."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { turnId: "turn-a-1", status: "reversed" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w3")).toMatchObject([
      { turnId: "turn-b-0", status: "reversed" },
    ]);
  });

  it("redoes a grouped undo by undo update sequence", async () => {
    const ctx = harness({ "chapter.md": "Base." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["One.", "Two.", "Three."]);

    const afterWrites = blockTexts(ctx.liveDoc("chapter.md"));
    const undo = await ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w1", to: "w3" },
      context,
    );

    expect(outcomeText(undo)).toContain("undo: 3 edit(s)");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoWriteId: "w1",
    });

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toContain("redo: 3 edit(s)");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(afterWrites);
    for (const writeId of ["w1", "w2", "w3"]) {
      expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, writeId)).toMatchObject([
        { status: "active" },
      ]);
    }
  });

  it("refuses redo when any in-memory reversal row in the group is no longer reversed", async () => {
    const ctx = harness({ "chapter.md": "Base." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["One.", "Two."]);

    await ctx.core.write({ command: "undo", file: "chapter.md", from: "w1", to: "w2" }, context);
    markStoredReversalStatus(ctx.journal, "chapter.md", "w1", "redone");

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expectOutcome(redo, "nothing_to_redo");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Base."]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "reversed" },
    ]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w2")).toMatchObject([
      { status: "reversed" },
    ]);
  });

  it("refuses the swordblade case when a later undone write consumed the selected write", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeDependentSwordSaber(ctx);

    const undoLater = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expectOutcome(undoLater, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

    const undoEarlier = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expectOutcome(undoEarlier, "cant_undo_dependent", true);
    expect(outcomeText(undoEarlier)).toContain("w2 was built on it");
    expect(outcomeText(undoEarlier)).toContain("undo the range w1..w2");
    expectNoInternalIds(outcomeText(undoEarlier));
    expect(outcomeText(undoEarlier)).not.toMatch(/\b(Yjs|struct|delete set|documentId)\b/i);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("refuses the swordsaber case while the dependent later write is still active", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeDependentSwordSaber(ctx);

    const undoEarlier = await ctx.core.write(
      { command: "undo", file: "chapter.md", to: "w1" },
      context,
    );

    expectOutcome(undoEarlier, "cant_undo_dependent", true);
    expect(outcomeText(undoEarlier)).toContain("w2 was built on it");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha saber."]);
  });

  it("allows a range that contains the dependent write cluster", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeDependentSwordSaber(ctx);

    const undo = await ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w1", to: "w2" },
      context,
    );

    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
  });

  it("allows all when it contains the dependent write cluster", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeDependentSwordSaber(ctx);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", all: true }, context);

    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);
  });

  it("allows the default newest single undo in a dependent cluster", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeDependentSwordSaber(ctx);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("does not refuse a non-overlapping earlier write", async () => {
    const ctx = harness(
      { "chapter.md": "Alpha sword.\n\nBeta shield." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-independent" },
    );
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "ward", find: "shield" },
      { ...context, turnId: "turn-independent" },
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);

    expectOutcome(undo, "reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword.", "Beta ward."]);
  });

  it("preserves same-area human edits when undoing a selected write", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    humanText(
      ctx.liveDoc("chapter.md"),
      0,
      { from: "Alpha blade.".length, to: "Alpha blade.".length },
      " Human.",
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);

    expect(outcomeText(undo)).toContain("status: reconciled");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword. Human."]);
  });

  it("supports last and all selectors", async () => {
    const lastCtx = harness({ "chapter.md": "Base." });
    await lastCtx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(lastCtx, ["One.", "Two.", "Three.", "Four."]);

    await lastCtx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context);
    expect(blockTexts(lastCtx.liveDoc("chapter.md"))).toEqual(["Base.", "One.", "Two."]);

    const allCtx = harness({ "chapter.md": "Base." });
    await allCtx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(allCtx, ["One.", "Two.", "Three."]);

    await allCtx.core.write({ command: "undo", file: "chapter.md", all: true }, context);
    expect(blockTexts(allCtx.liveDoc("chapter.md"))).toEqual(["Base."]);
  });

  it("blocks redo after a forward write follows an undo", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-redo-gate" },
    );
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

  it("refuses undo with generic wording when an untracked later edit depends on the write", async () => {
    const ctx = harness({ "chapter.md": "Base." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await appendBlocks(ctx, ["Dependent."]);

    const live = ctx.liveDoc("chapter.md");
    const beforeHuman = Y.encodeStateVector(live);
    const inserted = model.getBlocks(live)[1];
    if (!inserted) throw new Error("expected inserted block");
    live.transact(() => model.deleteBlock(live, inserted), { type: "human" });
    await ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeHuman), {
      origin: "human:user-a",
      seq: 0,
    });

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", to: "w1" }, context);

    expectOutcome(undo, "cant_undo_dependent", true);
    expect(outcomeText(undo)).toContain("a later edit was built on it");
    expectNoInternalIds(outcomeText(undo));
    expect(outcomeText(undo)).not.toMatch(/document|thread|undo update seq|Yjs|struct|delete set/i);
  });

  it("validates ranges and unknown handles without crashing", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write({ command: "insert", file: "chapter.md", content: "Beta." }, context);

    const inverted = await ctx.core.write(
      { command: "undo", file: "chapter.md", from: "w2", to: "w1" },
      context,
    );
    expectOutcome(inverted, "invalid_write", true);
    expect(outcomeText(inverted)).toContain("from must be before or equal to to");

    expect(
      outcomeText(
        await ctx.core.write({ command: "undo", file: "chapter.md", to: "w99" }, context),
      ),
    ).toBe("status: nothing_to_undo");
    expect(
      outcomeText(
        await ctx.core.write({ command: "redo", file: "chapter.md", to: "w99" }, context),
      ),
    ).toBe("status: nothing_to_redo");
  });

  it("treats cold undo target drift as a non-retained write", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    const invariantMessages: string[] = [];
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-cold-undo-drift" },
    );
    const driftCore = createAgentEditCore({
      journal: journalWithMissingMutationTarget(ctx.journal, {
        writeId: "w1",
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

    expectOutcome(undo, "nothing_to_undo");
    expect(outcomeText(undo)).toBe("status: nothing_to_undo");
    expect(invariantMessages).toEqual([]);
    expect(await ctx.journal.readReversals("chapter.md", { threadId: THREAD_ID })).toEqual([]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "active" },
    ]);
  });

  it("treats cold redo target drift as a non-retained write", async () => {
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
        writeId: "w1",
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

    expectOutcome(redo, "nothing_to_redo");
    expect(outcomeText(redo)).toBe("status: nothing_to_redo");
    expect(invariantMessages).toEqual([]);
    expect(await ctx.journal.mutationsForWrite("chapter.md", THREAD_ID, "w1")).toMatchObject([
      { status: "reversed" },
    ]);
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
      undoWriteId: "w1",
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

  it("reports redo unavailable when compaction drops retained reversal rows", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword waits." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-redo-compacted-prefix" },
    );
    const stateAfterForwardWrite = Y.encodeStateAsUpdate(ctx.liveDoc("chapter.md"));
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(await ctx.core.getAvailability("chapter.md", THREAD_ID)).toEqual({
      undo: false,
      redo: true,
      redoWriteId: "w1",
    });

    await ctx.journal.checkpoint("chapter.md", stateAfterForwardWrite, 1);
    await ctx.journal.compact("chapter.md", new Date(Date.now() + 1_000));

    expect((await ctx.journal.read("chapter.md")).updates).toEqual([]);
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

  it("cold undo filters interleaved journal targets by thread", async () => {
    const threadB = "thread-b";
    const contextB = { sessionId: "session-b", threadId: threadB };
    const ctx = harness({
      "chapter.md": "Paragraph 1 original.\n\nParagraph 2 original.\n\nParagraph 3 original.",
    });

    await ctx.core.write({ command: "view", file: "chapter.md" }, contextB);
    await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Thread B paragraph 2.",
        find: "Paragraph 2 original.",
      },
      { ...contextB, turnId: "turn-b-1" },
    );
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "Thread A paragraph 1.",
        find: "Paragraph 1 original.",
      },
      { ...context, turnId: "turn-a" },
    );
    await ctx.core.write({ command: "view", file: "chapter.md" }, contextB);
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

    expectOutcome(undo, "reversed");
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

async function appendBlocks(
  ctx: ReturnType<typeof harness>,
  blocks: readonly string[],
  turnId = "turn-append",
): Promise<void> {
  for (const [index, block] of blocks.entries()) {
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: block },
      { ...context, turnId: `${turnId}-${index}` },
    );
  }
}

async function writeDependentSwordSaber(ctx: ReturnType<typeof harness>): Promise<void> {
  await ctx.core.write({ command: "view", file: "chapter.md" }, context);
  await ctx.core.write(
    { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
    { ...context, turnId: "turn-dependent-writes" },
  );
  await ctx.core.write(
    { command: "replace", file: "chapter.md", content: "saber", find: "blade" },
    { ...context, turnId: "turn-dependent-writes" },
  );
  expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha saber."]);
}

async function checkpointLiveDoc(
  ctx: ReturnType<typeof harness>,
  docId: string,
  upToSeq: number,
): Promise<void> {
  await ctx.journal.checkpoint(docId, Y.encodeStateAsUpdate(ctx.liveDoc(docId)), upToSeq);
}

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
  missing: Pick<WriteMutationRow, "status" | "createdSeq" | "undoUpdateSeq"> & {
    writeId: string;
  },
): UpdateJournal & ReversalStore {
  return {
    append: journal.append.bind(journal),
    reserveWriteOrdinal: journal.reserveWriteOrdinal.bind(journal),
    appendBatch: journal.appendBatch.bind(journal),
    latestActiveWrite: journal.latestActiveWrite.bind(journal),
    activeWriteSummary: journal.activeWriteSummary.bind(journal),
    writeMinCreatedSeq: journal.writeMinCreatedSeq.bind(journal),
    mutationsForWrite: async (documentId, threadId, handle) => {
      const rows = await journal.mutationsForWrite(documentId, threadId, handle);
      if (handle !== missing.writeId) return rows;
      const source = rows[0];
      if (!source) return rows;
      return [
        ...rows,
        {
          writeId: source.writeId,
          handle: source.handle,
          wId: source.wId,
          turnId: source.turnId,
          createdSeq: missing.createdSeq,
          status: missing.status,
          ...(missing.undoUpdateSeq !== undefined ? { undoUpdateSeq: missing.undoUpdateSeq } : {}),
        },
      ];
    },
    read: journal.read.bind(journal),
    readForReconstruction: journal.readForReconstruction.bind(journal),
    checkpoint: journal.checkpoint.bind(journal),
    compact: journal.compact.bind(journal),
    persistUndo: journal.persistUndo.bind(journal),
    persistRedo: journal.persistRedo.bind(journal),
    readReversals: journal.readReversals.bind(journal),
  };
}

function markStoredReversalStatus(
  journal: MemoryJournal,
  docId: string,
  writeId: string,
  status: ReversalStatus,
): void {
  const entry = (
    journal as unknown as {
      data: Map<
        string,
        { reversals: Map<string, { record: { writeIds: string[]; status: string } }> }
      >;
    }
  ).data.get(docId);
  const stored = [...(entry?.reversals.values() ?? [])].find((candidate) =>
    candidate.record.writeIds.includes(writeId),
  );
  if (!stored) throw new Error(`missing stored reversal for ${writeId}`);
  stored.record.status = status;
}

function setStoredUpdateTime(
  journal: MemoryJournal,
  docId: string,
  seq: number,
  storedAt: Date,
): void {
  const entry = (
    journal as unknown as {
      data: Map<string, { updates: Array<{ seq: number; storedAt: Date }> }>;
    }
  ).data.get(docId);
  const update = entry?.updates.find((candidate) => candidate.seq === seq);
  if (!update) throw new Error(`missing stored update seq ${seq}`);
  update.storedAt = storedAt;
}
