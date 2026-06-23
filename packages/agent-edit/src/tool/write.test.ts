// End-to-end write(command=...) coverage with in-memory port fakes.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import type { TurnMutationRow, UpdateJournal } from "../ports/update-journal.js";
import { createUndoManagerRegistry } from "../undo/manager-registry.js";
import {
  blockTexts,
  documentBytes,
  expectNoInternalIds,
  expectOutcome,
  hashAt,
  humanText,
  outcomeText,
  renderedBlockBodies,
  serializeDoc,
} from "./test-support/assertions.js";
import type { MemoryJournal } from "./test-support/recording-journal.js";
import {
  cloneDoc,
  codec,
  context,
  harness,
  MemoryCoordinator,
  MemoryDocumentLifecycle,
  model,
  REVERSAL_CLIENT_ID,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

describe("write tool dispatch", () => {
  it("views block-hashed document content and scoped outline sections", async () => {
    const ctx = harness({ "chapter.md": "# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits." });

    const full = await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    expectOutcome(full, "success");
    expect(outcomeText(full)).toMatch(/^[0-9a-f]{4}\|# Chapter/m);
    expect(outcomeText(full)).toContain("|Alpha sword.");

    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const section = await ctx.core.write(
      { command: "view", file: `chapter.md#${headingHash}` },
      context,
    );
    expect(outcomeText(section)).toContain("|## Arena");
    expect(outcomeText(section)).toContain("|Beta waits.");

    const outline = await ctx.core.write(
      { command: "view", file: "chapter.md", format: "outline" },
      context,
    );
    expect(outcomeText(outline)).toContain(
      `write(command="view", file="chapter.md#${headingHash}")`,
    );
  });

  it("creates a document with initial content", async () => {
    const ctx = harness();
    ctx.coordinator.createEmpty("new.md");

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expectOutcome(result, "success");
    expect(outcomeText(result)).toContain("|# Draft");
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
  });

  it("creates a new file through DocumentLifecycle and persists the journal update", async () => {
    const ctx = harness();

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
    expect(
      renderedBlockBodies(await ctx.core.write({ command: "view", file: "new.md" }, context)),
    ).toEqual(["# Draft", "Opening line."]);

    const snapshot = await ctx.journal.read("new.md");
    expect(snapshot.checkpoint).toBeNull();
    expect(snapshot.updates).toHaveLength(1);
    const replayed = new Y.Doc({ gc: false });
    for (const update of snapshot.updates) Y.applyUpdate(replayed, update.update);
    expect(blockTexts(replayed)).toEqual(["Draft", "Opening line."]);
  });

  it("rejects create for an existing non-empty file", async () => {
    const ctx = harness({ "chapter.md": "Already here." });

    const result = await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Replacement." },
      context,
    );

    expect(outcomeText(result)).toContain("status: invalid_write");
    expectOutcome(result, "invalid_write", true);
    expect(outcomeText(result)).toContain("File already exists: chapter.md");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Already here."]);
  });

  it("returns a clean unsupported error when create has no lifecycle", async () => {
    const ctx = harness({}, { lifecycle: false });

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "Draft." },
      context,
    );

    expect(outcomeText(result)).toContain("status: invalid_write");
    expect(outcomeText(result)).toContain("document creation is not supported by this deployment");
  });

  it("inserts by block hash, by find, and deduplicates tool_use_id", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nOmega." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const byHash = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Inserted scene.", after: alphaHash },
      context,
    );

    expect(outcomeText(byHash)).toContain("status: success");
    expect(outcomeText(byHash)).toContain("Inserted scene.");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Inserted scene.", "Omega."]);

    const first = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "Alpha",
        tool_use_id: "same-call",
      },
      context,
    );
    const replay = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "Alpha",
        tool_use_id: "same-call",
      },
      context,
    );

    expect(replay).toBe(first);
    expectOutcome(first, "success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha!.");
  });

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

  it("formats undo and redo responses without internal UUIDs and with fresh undo hashes", async () => {
    const ctx = harness({
      "chapter.md":
        "Beta waits in the clearing, sword drawn.\n\nThe wind carries the scent of rain.",
    });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const originalHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    await ctx.core.write(
      { command: "replace", file: `chapter.md#${originalHash}`, content: "" },
      { ...context, turnId: "turn-response-format" },
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const undoLines = outcomeText(undo).split("\n");

    expect(undoLines.slice(0, 4)).toEqual(["status: reversed", "", "undo: 1 edit(s)", ""]);
    expect(undoLines[4]).toMatch(/^[0-9a-f]{4}\|Beta waits in the clearing, sword drawn\.$/);
    expect(undoLines[4]?.split("|")[0]).not.toBe(originalHash);
    expectNoInternalIds(outcomeText(undo));

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo).split("\n").slice(0, 4)).toEqual([
      "status: reversed",
      "",
      "redo: 1 edit(s)",
      "",
    ]);
    expectNoInternalIds(outcomeText(redo));
  });

  it("formats partial undo and redo responses without internal IDs", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-partial-format" },
    );

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md", last: 2 }, context);

    expect(outcomeText(undo)).toContain("status: partial");
    expect(outcomeText(undo)).toContain("undo: 1 edit(s)");
    expectNoInternalIds(outcomeText(undo));

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md", last: 2 }, context);

    expect(outcomeText(redo)).toContain("status: partial");
    expect(outcomeText(redo)).toContain("redo: 1 edit(s)");
    expectNoInternalIds(outcomeText(redo));
  });

  it("filters expired redo records without leaking internal IDs", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { retention: { reversalWindowMs: -1 } });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-expired-format" },
    );
    await ctx.core.write({ command: "undo", file: "chapter.md" }, context);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);

    expect(outcomeText(redo)).toBe("status: nothing_to_redo");
    expectNoInternalIds(outcomeText(redo));
  });

  it("invalidates a thread runtime and rebuilds the next view from recovered live state", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-before-invalidate" },
    );

    const live = ctx.liveDoc("chapter.md");
    const beforeVector = Y.encodeStateVector(live);
    humanText(live, 0, { from: 0, to: 0 }, "Human ");
    await ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeVector), {
      origin: "human:user-a",
      seq: 0,
    });

    ctx.core.invalidateThread("chapter.md", THREAD_ID);

    const view = await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    expect(outcomeText(view)).toContain("|Human Alpha blade.");
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

  it("appends unanchored inserts and handles explicit start and end anchors", async () => {
    const noAnchorCtx = harness({ "chapter.md": "One\n\nTwo\n\nThree" });
    await noAnchorCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const noAnchor = await noAnchorCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Four\n\nFive" },
      context,
    );

    expect(outcomeText(noAnchor)).toContain("status: success");
    const expectedEndOrder = ["One", "Two", "Three", "Four", "Five"];
    expect(blockTexts(noAnchorCtx.liveDoc("chapter.md"))).toEqual(expectedEndOrder);
    expect(
      renderedBlockBodies(
        await noAnchorCtx.core.write({ command: "view", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedEndOrder);

    const beforeFirstCtx = harness({ "chapter.md": "Alpha\n\nBeta" });
    await beforeFirstCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const firstHash = hashAt(beforeFirstCtx.liveDoc("chapter.md"), 0);

    const beforeFirst = await beforeFirstCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Start A\n\nStart B", before: firstHash },
      context,
    );

    expect(outcomeText(beforeFirst)).toContain("status: success");
    const expectedStartOrder = ["Start A", "Start B", "Alpha", "Beta"];
    expect(blockTexts(beforeFirstCtx.liveDoc("chapter.md"))).toEqual(expectedStartOrder);
    expect(
      renderedBlockBodies(
        await beforeFirstCtx.core.write({ command: "view", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedStartOrder);

    const afterLastCtx = harness({ "chapter.md": "One\n\nTwo\n\nThree" });
    await afterLastCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const lastHash = hashAt(afterLastCtx.liveDoc("chapter.md"), 2);

    const afterLast = await afterLastCtx.core.write(
      { command: "insert", file: "chapter.md", content: "Four\n\nFive", after: lastHash },
      context,
    );

    expect(outcomeText(afterLast)).toContain("status: success");
    expect(blockTexts(afterLastCtx.liveDoc("chapter.md"))).toEqual(expectedEndOrder);
    expect(
      renderedBlockBodies(
        await afterLastCtx.core.write({ command: "view", file: "chapter.md" }, context),
      ),
    ).toEqual(expectedEndOrder);

    const emptyCtx = harness();
    emptyCtx.coordinator.createEmpty("empty.md");
    await emptyCtx.core.write({ command: "view", file: "empty.md" }, context);

    const emptyInsert = await emptyCtx.core.write(
      { command: "insert", file: "empty.md", content: "Only block" },
      context,
    );

    expect(outcomeText(emptyInsert)).toContain("status: success");
    expect(blockTexts(emptyCtx.liveDoc("empty.md"))).toEqual(["Only block"]);
    expect(
      renderedBlockBodies(
        await emptyCtx.core.write({ command: "view", file: "empty.md" }, context),
      ),
    ).toEqual(["Only block"]);
  });

  it("replaces text, formatting, and deletes through replace(content='')", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword.\n\nDelete me." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const text = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(outcomeText(text)).toContain("status: success");
    expect(outcomeText(text)).toContain("|Alpha blade.");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha blade.");

    const formatted = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "**blade**", find: "blade" },
      context,
    );
    expect(outcomeText(formatted)).toContain("status: success");
    expect(outcomeText(formatted)).toContain("|Alpha **blade**.");
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toContain("Alpha **blade**.");

    const deleteHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const deletion = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", in: deleteHash },
      context,
    );

    expect(outcomeText(deletion)).toContain("status: success");
    expect(outcomeText(deletion)).toContain(`deleted: ${deleteHash}`);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("replaces and deletes find matches that span block boundaries", async () => {
    const replaceCtx = harness({ "chapter.md": "Alpha starts\n\nends Omega" });
    await replaceCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const replaced = await replaceCtx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "middle",
        find: "starts\n\nends",
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(replaceCtx.liveDoc("chapter.md"))).toEqual(["Alpha middle Omega"]);

    const deleteCtx = harness({ "chapter.md": "Before X\n\nMiddle\n\nY After" });
    await deleteCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const deleted = await deleteCtx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "",
        find: "X\n\nMiddle\n\nY",
      },
      context,
    );

    expect(outcomeText(deleted)).toContain("status: success");
    expect(blockTexts(deleteCtx.liveDoc("chapter.md"))).toEqual(["Before  After"]);

    const insertCtx = harness({ "chapter.md": "Alpha starts\n\nends Omega" });
    await insertCtx.core.write({ command: "view", file: "chapter.md" }, context);

    const inserted = await insertCtx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "starts\n\nends",
      },
      context,
    );

    expect(outcomeText(inserted)).toContain("status: success");
    expect(blockTexts(insertCtx.liveDoc("chapter.md"))).toEqual(["Alpha starts", "ends! Omega"]);
  });

  it("views around windows with radius three and clamps at document edges", async () => {
    const ctx = harness({ "chapter.md": numberedBlocks(9) });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const middleHash = hashAt(ctx.liveDoc("chapter.md"), 4);
    const nearStartHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const nearEndHash = hashAt(ctx.liveDoc("chapter.md"), 7);

    const middle = await ctx.core.write(
      { command: "view", file: "chapter.md", around: middleHash },
      context,
    );
    const middleWithHashPrefix = await ctx.core.write(
      { command: "view", file: "chapter.md", around: `#${middleHash}` },
      context,
    );
    const nearStart = await ctx.core.write(
      { command: "view", file: "chapter.md", around: nearStartHash },
      context,
    );
    const nearEnd = await ctx.core.write(
      { command: "view", file: "chapter.md", around: nearEndHash },
      context,
    );

    expect(renderedBlockBodies(middle)).toEqual([
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
    ]);
    expect(outcomeText(middleWithHashPrefix)).toBe(outcomeText(middle));
    expect(renderedBlockBodies(nearStart)).toEqual([
      "Block 1",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
    ]);
    expect(renderedBlockBodies(nearEnd)).toEqual([
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9",
    ]);
  });

  it("scopes find-based replace and insert to around windows", async () => {
    const replaceCtx = harness({ "chapter.md": aroundNeedleBlocks() });
    await replaceCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const replaceAround = hashAt(replaceCtx.liveDoc("chapter.md"), 4);

    const replaced = await replaceCtx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "changed",
        find: "needle",
        around: replaceAround,
      },
      context,
    );

    expect(outcomeText(replaced)).toContain("status: success");
    expect(blockTexts(replaceCtx.liveDoc("chapter.md"))).toEqual([
      "Block 1 needle",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5 changed",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9 needle",
    ]);

    const insertCtx = harness({ "chapter.md": aroundNeedleBlocks() });
    await insertCtx.core.write({ command: "view", file: "chapter.md" }, context);
    const insertAround = hashAt(insertCtx.liveDoc("chapter.md"), 4);

    const inserted = await insertCtx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "needle",
        around: insertAround,
      },
      context,
    );

    expect(outcomeText(inserted)).toContain("status: success");
    expect(blockTexts(insertCtx.liveDoc("chapter.md"))).toEqual([
      "Block 1 needle",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5 needle!",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9 needle",
    ]);
  });

  it("keeps find-based replacement reachable through file fragments", async () => {
    const ctx = harness({ "chapter.md": "# Arena\n\nsword here\n\n# After\n\nsword there" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const result = await ctx.core.write(
      { command: "replace", file: `chapter.md#${headingHash}`, content: "blade", find: "sword" },
      context,
    );

    expect(outcomeText(result)).toContain("status: success");
    expect(outcomeText(result)).toContain("|blade here");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Arena",
      "blade here",
      "After",
      "sword there",
    ]);
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

  it("rehydrates durable redo after restart and marks it redone", async () => {
    const turnId = "thread-a:chapter.md:turn-restart-redo";

    async function writeThenUndo(ctx: ReturnType<typeof harness>) {
      await ctx.core.write({ command: "view", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        { ...context, turnId },
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

      const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      expect(outcomeText(undo)).toContain("status: reversed");
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

      const [reversal] = await ctx.journal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      });
      expect(reversal).toMatchObject({ turnId, status: "reversed" });
      expect(reversal?.undoUpdateSeq).toBeGreaterThan(0);
    }

    const hot = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await writeThenUndo(hot);
    const coldCoordinator = new MemoryCoordinator({});
    coldCoordinator.docs.set("chapter.md", cloneDoc(hot.liveDoc("chapter.md")));
    const coldLifecycle = new MemoryDocumentLifecycle(coldCoordinator);
    const coldJournal = hot.journal.clone();

    const hotRedo = await hot.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(hotRedo)).toContain("status: reversed");
    const hotTexts = blockTexts(hot.liveDoc("chapter.md"));
    const hotBytes = documentBytes(hot.liveDoc("chapter.md"));

    const restarted = createAgentEditCore({
      journal: coldJournal,
      coordinator: coldCoordinator,
      lifecycle: coldLifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expect(
      outcomeText(await restarted.write({ command: "view", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");

    const coldRedo = await restarted.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(coldRedo)).toContain("status: reversed");
    expect(blockTexts(coldCoordinator.require("chapter.md"))).toEqual(hotTexts);
    expect(documentBytes(coldCoordinator.require("chapter.md"))).toEqual(hotBytes);

    expect(
      await coldJournal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      }),
    ).toEqual([]);
    expect(
      await coldJournal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["redone"],
      }),
    ).toMatchObject([{ turnId, status: "redone" }]);

    const secondRestart = createAgentEditCore({
      journal: coldJournal,
      coordinator: coldCoordinator,
      lifecycle: coldLifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    await secondRestart.write({ command: "view", file: "chapter.md" }, context);

    const doubleRedo = await secondRestart.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(doubleRedo)).toBe("status: nothing_to_redo");
    expect(blockTexts(coldCoordinator.require("chapter.md"))).toEqual(hotTexts);
    expect(documentBytes(coldCoordinator.require("chapter.md"))).toEqual(hotBytes);
  });

  it("consumes durable redo once across concurrent restarted sessions", async () => {
    const turnId = "thread-a:chapter.md:turn-concurrent-redo";
    const initial = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await initial.core.write({ command: "view", file: "chapter.md" }, context);
    await initial.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId },
    );
    expect(
      outcomeText(await initial.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("status: reversed");
    expect(blockTexts(initial.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

    const coreA = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coreB = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });

    expect(
      outcomeText(await coreA.write({ command: "view", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");
    expect(
      outcomeText(await coreB.write({ command: "view", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");

    const redoA = await coreA.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoA)).toContain("status: reversed");
    const redoB = await coreB.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoB)).toBe("status: nothing_to_redo");

    expect(blockTexts(initial.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
    expect(
      await initial.journal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["redone"],
      }),
    ).toMatchObject([{ turnId, status: "redone" }]);
    expect(
      await initial.journal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      }),
    ).toEqual([]);
  });

  it("re-syncs undo and redo before marking the snapshot synced", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    humanText(ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(outcomeText(undo)).toContain("status: reconciled");
    expectNoInternalIds(outcomeText(undo));
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha sword."]);

    const followup = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "Writer", find: "Human" },
      context,
    );
    expect(outcomeText(followup)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Writer Alpha sword."]);

    const redoCtx = harness({ "chapter.md": "Alpha sword." });
    await redoCtx.core.write({ command: "view", file: "chapter.md" }, context);
    await redoCtx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    await redoCtx.core.write({ command: "undo", file: "chapter.md" }, context);
    humanText(redoCtx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");

    const redo = await redoCtx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redo)).toContain("status: reconciled");
    expectNoInternalIds(outcomeText(redo));
    expect(blockTexts(redoCtx.liveDoc("chapter.md"))).toEqual(["Human Alpha blade."]);

    const redoFollowup = await redoCtx.core.write(
      { command: "replace", file: "chapter.md", content: "Writer", find: "Human" },
      context,
    );
    expect(outcomeText(redoFollowup)).toContain("status: success");
    expect(blockTexts(redoCtx.liveDoc("chapter.md"))).toEqual(["Writer Alpha blade."]);
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
      expect(undoText).not.toContain("turn-with-two-writes");
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

  it("returns LLM-readable not_found, ambiguous_match, and invalid_write errors", async () => {
    const ctx = harness({ "chapter.md": "sword one\n\nsword two" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const missing = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "x", after: "deadbeef" },
      context,
    );
    expect(outcomeText(missing)).toContain("status: not_found");
    expectOutcome(missing, "not_found", true);
    expect(outcomeText(missing)).toContain('write(command="view", file="chapter.md")');

    const ambiguous = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(outcomeText(ambiguous)).toContain("status: ambiguous_match");
    expectOutcome(ambiguous, "ambiguous_match", true);
    expect(outcomeText(ambiguous)).toContain("Found 2 matches");

    const invalid = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "" },
      context,
    );
    expect(outcomeText(invalid)).toContain("status: invalid_write");
    expectOutcome(invalid, "invalid_write", true);
    expect(outcomeText(invalid)).toContain("insert requires non-empty content");
  });

  it("returns invalid_write for invalid around scope combinations", async () => {
    const ctx = harness({ "chapter.md": aroundNeedleBlocks() });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const inHash = hashAt(ctx.liveDoc("chapter.md"), 4);
    const aroundHash = hashAt(ctx.liveDoc("chapter.md"), 5);

    const bothScopes = await ctx.core.write(
      {
        command: "replace",
        file: "chapter.md",
        content: "changed",
        find: "needle",
        in: inHash,
        around: aroundHash,
      },
      context,
    );
    expect(outcomeText(bothScopes)).toContain("status: invalid_write");
    expect(outcomeText(bothScopes)).toContain(
      "`in` and `around` are mutually exclusive scope parameters",
    );

    const aroundWithoutFind = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "changed", around: aroundHash },
      context,
    );
    expect(outcomeText(aroundWithoutFind)).toContain("status: invalid_write");
    expect(outcomeText(aroundWithoutFind)).toContain(
      "`around` only scopes find-based replace commands",
    );
  });

  it("maps typed missing documents differently from transient coordinator failures", async () => {
    const missingCtx = harness();

    const missing = await missingCtx.core.write({ command: "view", file: "missing.md" }, context);

    expect(outcomeText(missing)).toContain("status: document_not_found");
    expectOutcome(missing, "document_not_found", true);

    const failingCtx = harness({ "chapter.md": "Alpha." });
    failingCtx.coordinator.failWith(new Error("database unavailable"));

    const transient = await failingCtx.core.write({ command: "view", file: "chapter.md" }, context);

    expect(outcomeText(transient)).toContain("status: internal_error");
    expectOutcome(transient, "internal_error", true);
    expect(outcomeText(transient)).toContain("database unavailable");
  });
});

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

function numberedBlocks(count: number): string {
  return Array.from({ length: count }, (_, index) => `Block ${index + 1}`).join("\n\n");
}

function aroundNeedleBlocks(): string {
  return [
    "Block 1 needle",
    "Block 2",
    "Block 3",
    "Block 4",
    "Block 5 needle",
    "Block 6",
    "Block 7",
    "Block 8",
    "Block 9 needle",
  ].join("\n\n");
}
