// Runtime-store cache invalidation, recovery, redo rehydration, and sync contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import { blockTexts, documentBytes, humanText, outcomeText } from "./test-support/assertions.js";
import {
  cloneDoc,
  codecFactory,
  context,
  harness,
  MemoryCoordinator,
  MemoryDocumentLifecycle,
  model,
  REVERSAL_CLIENT_ID,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

describe("runtime store", () => {
  it("invalidates a thread runtime and rebuilds the next edit from recovered live state", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.read({ file: "chapter.md" }, context);
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

    await ctx.core.invalidateThread("chapter.md", THREAD_ID);

    const edit = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "blade", content: "saber" },
      context,
    );

    expect(outcomeText(edit)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha saber."]);
  });

  it("commits a fresh-process destructive write without calling its own edit a sweep", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    const responseContext = {
      ...context,
      turnId: "turn-before-fresh-process",
      responseId: "response-before-fresh-process",
    };
    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta shield." },
      responseContext,
    );
    expect(outcomeText(staged)).toContain("status: success");
    await ctx.core.commitResponse("response-before-fresh-process");

    const freshCore = createAgentEditCore({
      journal: ctx.journal,
      coordinator: ctx.coordinator,
      lifecycle: ctx.lifecycle,
      codec: codecFactory,
      links: createStaticDocumentLinks(),
      model,
    });

    const edit = await freshCore.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      { ...context, turnId: "turn-fresh-process-no-read" },
    );

    expect(outcomeText(edit)).toContain("status: success");
    expect(outcomeText(edit)).not.toContain("swept");
    expect(
      edit.result.blocks?.some((group) =>
        group.items.some((block) => block.body === "Beta shield."),
      ),
    ).toBe(true);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade.", "Beta shield."]);
  });

  it("rehydrates durable redo after restart and marks it redone", async () => {
    const turnId = "thread-a:chapter.md:turn-restart-redo";

    async function writeThenUndo(ctx: ReturnType<typeof harness>) {
      await ctx.core.read({ file: "chapter.md" }, context);
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

    const baseline = harness(
      { "chapter.md": "Alpha sword." },
      { undoClientId: REVERSAL_CLIENT_ID },
    );
    await writeThenUndo(baseline);
    const restartedCoordinator = new MemoryCoordinator({});
    restartedCoordinator.docs.set("chapter.md", cloneDoc(baseline.liveDoc("chapter.md")));
    const restartedLifecycle = new MemoryDocumentLifecycle(restartedCoordinator);
    const restartedJournal = baseline.journal.clone();

    const baselineRedo = await baseline.core.write(
      { command: "redo", file: "chapter.md" },
      context,
    );
    expect(outcomeText(baselineRedo)).toContain("status: reversed");
    const baselineTexts = blockTexts(baseline.liveDoc("chapter.md"));
    const baselineBytes = documentBytes(baseline.liveDoc("chapter.md"));

    const restarted = createAgentEditCore({
      journal: restartedJournal,
      coordinator: restartedCoordinator,
      lifecycle: restartedLifecycle,
      codec: codecFactory,
      links: createStaticDocumentLinks(),
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expect(outcomeText(await restarted.read({ file: "chapter.md" }, context))).toContain(
      "Alpha sword.",
    );

    const restartedRedo = await restarted.write(
      { command: "redo", file: "chapter.md" },
      {
        ...context,
        actor: {
          kind: "agent",
          turnId: "test-restarted-redo",
          threadId: THREAD_ID,
          responseId: "test-observed-response",
        },
      },
    );
    expect(outcomeText(restartedRedo)).toContain("status: reversed");
    expect(blockTexts(restartedCoordinator.require("chapter.md"))).toEqual(baselineTexts);
    expect(documentBytes(restartedCoordinator.require("chapter.md"))).toEqual(baselineBytes);

    expect(
      await restartedJournal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["reversed"],
      }),
    ).toEqual([]);
    expect(
      await restartedJournal.readReversals("chapter.md", {
        threadId: context.threadId,
        status: ["redone"],
      }),
    ).toMatchObject([{ turnId, status: "redone" }]);

    const secondRestart = createAgentEditCore({
      journal: restartedJournal,
      coordinator: restartedCoordinator,
      lifecycle: restartedLifecycle,
      codec: codecFactory,
      links: createStaticDocumentLinks(),
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    await secondRestart.read({ file: "chapter.md" }, context);

    const doubleRedo = await secondRestart.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(doubleRedo)).toBe("status: nothing_to_redo; path: chapter.md");
    expect(blockTexts(restartedCoordinator.require("chapter.md"))).toEqual(baselineTexts);
    expect(documentBytes(restartedCoordinator.require("chapter.md"))).toEqual(baselineBytes);
  });

  it("consumes durable redo once across concurrent restarted sessions", async () => {
    const turnId = "thread-a:chapter.md:turn-concurrent-redo";
    const initial = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await initial.core.read({ file: "chapter.md" }, context);
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
      codec: codecFactory,
      links: createStaticDocumentLinks(),
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coreB = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec: codecFactory,
      links: createStaticDocumentLinks(),
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });

    expect(outcomeText(await coreA.read({ file: "chapter.md" }, context))).toContain(
      "Alpha sword.",
    );
    expect(outcomeText(await coreB.read({ file: "chapter.md" }, context))).toContain(
      "Alpha sword.",
    );

    const redoA = await coreA.write(
      { command: "redo", file: "chapter.md" },
      {
        ...context,
        actor: {
          kind: "agent",
          turnId: "test-concurrent-redo",
          threadId: THREAD_ID,
          responseId: "test-observed-response",
        },
      },
    );
    expect(outcomeText(redoA)).toContain("status: reversed");
    const redoB = await coreB.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoB)).toBe("status: nothing_to_redo; path: chapter.md");

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
    await ctx.core.read({ file: "chapter.md" }, context);
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
    await redoCtx.core.read({ file: "chapter.md" }, context);
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
