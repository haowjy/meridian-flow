// Runtime-store cache invalidation, recovery, redo rehydration, and sync contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import { blockTexts, documentBytes, humanText, outcomeText } from "./test-support/assertions.js";
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

describe("runtime store", () => {
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
    expect(blockTexts(redoCtx.liveDoc("chapter.md"))).toEqual(["Human Alpha blade."]);

    const redoFollowup = await redoCtx.core.write(
      { command: "replace", file: "chapter.md", content: "Writer", find: "Human" },
      context,
    );
    expect(outcomeText(redoFollowup)).toContain("status: success");
    expect(blockTexts(redoCtx.liveDoc("chapter.md"))).toEqual(["Writer Alpha blade."]);
  });
});
