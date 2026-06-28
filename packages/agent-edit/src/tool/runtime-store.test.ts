// Runtime-store cache invalidation, recovery, redo rehydration, and sync contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore, type SyncState, type SyncStateStore } from "../index.js";
import {
  blockTexts,
  documentBytes,
  hashAt,
  humanText,
  outcomeText,
} from "./test-support/assertions.js";
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
  it("loads persisted sync state after restart so writes do not require a fresh read", async () => {
    const syncStateStore = new MemorySyncStateStore();
    const initial = harness({ "chapter.md": "Alpha sword waits." });
    const core = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec,
      model,
      syncStateStore,
    });
    await core.write({ command: "read", file: "chapter.md" }, context);
    await core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      context,
    );
    await waitForSyncState(syncStateStore, "chapter.md", THREAD_ID);

    const restarted = createAgentEditCore({
      journal: initial.journal,
      coordinator: initial.coordinator,
      lifecycle: initial.lifecycle,
      codec,
      model,
      syncStateStore,
    });

    const followup = await restarted.write(
      { command: "replace", file: "chapter.md", find: "blade", content: "saber" },
      context,
    );

    expect(outcomeText(followup)).toContain("status: success");
    expect(blockTexts(initial.liveDoc("chapter.md"))).toEqual(["Alpha saber waits."]);
  });

  it("invalidates a thread runtime and rebuilds the next edit from recovered live state", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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

    const edit = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "blade", content: "saber" },
      context,
    );

    expect(outcomeText(edit)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha saber."]);
  });

  it("rejects stale destructive pure-hash block replacement without mutating", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword.\n\nBeta shield." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);
    await appendHumanPrefixAndInvalidate(ctx, "chapter.md");

    const rejected = await ctx.core.write(
      { command: "replace", file: "chapter.md", in: alphaHash, content: "Agent replacement." },
      context,
    );

    expect(rejected.status).toBe("not_found");
    expect(outcomeText(rejected)).toContain("Document changed since your last read");
    expect(outcomeText(rejected)).toContain('Run write(command="read", file="chapter.md")');
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha sword.", "Beta shield."]);
  });

  it("rejects stale destructive pure-hash delete without mutating", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword.\n\nBeta shield." });
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
    const betaHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    await appendHumanPrefixAndInvalidate(ctx, "chapter.md");

    const rejected = await ctx.core.write(
      { command: "replace", file: "chapter.md", in: betaHash, content: "" },
      context,
    );

    expect(rejected.status).toBe("not_found");
    expect(outcomeText(rejected)).toContain("whole-block replace/delete by hash is unsafe");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha sword.", "Beta shield."]);
  });

  it("keeps non-destructive stale-doc operations on the auto-rebuild path", async () => {
    const readCtx = harness({ "chapter.md": "Alpha sword." });
    await readCtx.core.write({ command: "read", file: "chapter.md" }, context);
    await appendHumanPrefixAndInvalidate(readCtx, "chapter.md");
    const read = await readCtx.core.write({ command: "read", file: "chapter.md" }, context);
    expect(read.status).toBe("success");
    expect(outcomeText(read)).toContain("Human Alpha sword.");

    const insertCtx = harness({ "chapter.md": "Alpha sword.\n\nOmega." });
    await insertCtx.core.write({ command: "read", file: "chapter.md" }, context);
    const alphaHash = hashAt(insertCtx.liveDoc("chapter.md"), 0);
    await appendHumanPrefixAndInvalidate(insertCtx, "chapter.md");
    const insert = await insertCtx.core.write(
      { command: "insert", file: "chapter.md", after: alphaHash, content: "Inserted scene." },
      context,
    );
    expect(insert.status).toBe("success");
    expect(blockTexts(insertCtx.liveDoc("chapter.md"))).toEqual([
      "Human Alpha sword.",
      "Inserted scene.",
      "Omega.",
    ]);

    const replaceCtx = harness({ "chapter.md": "Alpha sword." });
    await replaceCtx.core.write({ command: "read", file: "chapter.md" }, context);
    await appendHumanPrefixAndInvalidate(replaceCtx, "chapter.md");
    const replace = await replaceCtx.core.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      context,
    );
    expect(replace.status).toBe("success");
    expect(blockTexts(replaceCtx.liveDoc("chapter.md"))).toEqual(["Human Alpha blade."]);

    const createCtx = harness({ "chapter.md": "Old draft." });
    await createCtx.core.write({ command: "read", file: "chapter.md" }, context);
    await appendHumanPrefixAndInvalidate(createCtx, "chapter.md");
    const create = await createCtx.core.write(
      { command: "create", file: "chapter.md", content: "Fresh draft.", overwrite: true },
      context,
    );
    expect(create.status).toBe("success");
    expect(blockTexts(createCtx.liveDoc("chapter.md"))).toEqual(["Fresh draft."]);
  });

  it("allows pure-hash replace and delete on non-stale docs and after re-read", async () => {
    const nonStale = harness({ "chapter.md": "Alpha sword.\n\nBeta shield." });
    await nonStale.core.write({ command: "read", file: "chapter.md" }, context);
    const alphaHash = hashAt(nonStale.liveDoc("chapter.md"), 0);
    const replaced = await nonStale.core.write(
      { command: "replace", file: "chapter.md", in: alphaHash, content: "Agent replacement." },
      context,
    );
    expect(replaced.status).toBe("success");
    expect(blockTexts(nonStale.liveDoc("chapter.md"))).toEqual([
      "Agent replacement.",
      "Beta shield.",
    ]);
    const betaHash = hashAt(nonStale.liveDoc("chapter.md"), 1);
    const deleted = await nonStale.core.write(
      { command: "replace", file: "chapter.md", in: betaHash, content: "" },
      context,
    );
    expect(deleted.status).toBe("success");
    expect(blockTexts(nonStale.liveDoc("chapter.md"))).toEqual(["Agent replacement."]);

    const reread = harness({ "chapter.md": "Alpha sword.\n\nBeta shield." });
    await reread.core.write({ command: "read", file: "chapter.md" }, context);
    const staleHash = hashAt(reread.liveDoc("chapter.md"), 0);
    await appendHumanPrefixAndInvalidate(reread, "chapter.md");
    const rejected = await reread.core.write(
      { command: "replace", file: "chapter.md", in: staleHash, content: "Agent replacement." },
      context,
    );
    expect(rejected.status).toBe("not_found");
    const freshRead = await reread.core.write({ command: "read", file: "chapter.md" }, context);
    expect(freshRead.status).toBe("success");
    const retried = await reread.core.write(
      { command: "replace", file: "chapter.md", in: staleHash, content: "Agent replacement." },
      context,
    );
    expect(retried.status).toBe("success");
    expect(blockTexts(reread.liveDoc("chapter.md"))).toEqual([
      "Agent replacement.",
      "Beta shield.",
    ]);
  });

  it("rehydrates durable redo after restart and marks it redone", async () => {
    const turnId = "thread-a:chapter.md:turn-restart-redo";

    async function writeThenUndo(ctx: ReturnType<typeof harness>) {
      await ctx.core.write({ command: "read", file: "chapter.md" }, context);
      await ctx.core.write(
        { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
        { ...context, turnId },
      );
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

      const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      expect(outcomeText(undo)).toContain("status: reconciled");
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
    expect(outcomeText(baselineRedo)).toContain("status: reconciled");
    const baselineTexts = blockTexts(baseline.liveDoc("chapter.md"));
    const baselineBytes = documentBytes(baseline.liveDoc("chapter.md"));

    const restarted = createAgentEditCore({
      journal: restartedJournal,
      coordinator: restartedCoordinator,
      lifecycle: restartedLifecycle,
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expect(
      outcomeText(await restarted.write({ command: "read", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");

    const restartedRedo = await restarted.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(restartedRedo)).toContain("status: reconciled");
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
      codec,
      model,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    await secondRestart.write({ command: "read", file: "chapter.md" }, context);

    const doubleRedo = await secondRestart.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(doubleRedo)).toBe("status: nothing_to_redo");
    expect(blockTexts(restartedCoordinator.require("chapter.md"))).toEqual(baselineTexts);
    expect(documentBytes(restartedCoordinator.require("chapter.md"))).toEqual(baselineBytes);
  });

  it("consumes durable redo once across concurrent restarted sessions", async () => {
    const turnId = "thread-a:chapter.md:turn-concurrent-redo";
    const initial = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await initial.core.write({ command: "read", file: "chapter.md" }, context);
    await initial.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId },
    );
    expect(
      outcomeText(await initial.core.write({ command: "undo", file: "chapter.md" }, context)),
    ).toContain("status: reconciled");
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
      outcomeText(await coreA.write({ command: "read", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");
    expect(
      outcomeText(await coreB.write({ command: "read", file: "chapter.md" }, context)),
    ).toContain("Alpha sword.");

    const redoA = await coreA.write({ command: "redo", file: "chapter.md" }, context);
    expect(outcomeText(redoA)).toContain("status: reconciled");
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
    await ctx.core.write({ command: "read", file: "chapter.md" }, context);
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
    await redoCtx.core.write({ command: "read", file: "chapter.md" }, context);
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

class MemorySyncStateStore implements SyncStateStore {
  private readonly states = new Map<string, SyncState>();

  async load(documentId: string, threadId: string): Promise<SyncState | null> {
    return this.states.get(key(documentId, threadId)) ?? null;
  }

  async save(documentId: string, threadId: string, state: SyncState): Promise<void> {
    this.states.set(key(documentId, threadId), state);
  }

  async delete(documentId: string, threadId: string): Promise<void> {
    this.states.delete(key(documentId, threadId));
  }
}

async function waitForSyncState(
  store: MemorySyncStateStore,
  documentId: string,
  threadId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await store.load(documentId, threadId)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("sync state was not persisted");
}

function key(documentId: string, threadId: string): string {
  return `${documentId}\0${threadId}`;
}

async function appendHumanPrefixAndInvalidate(ctx: ReturnType<typeof harness>, docId: string) {
  const live = ctx.liveDoc(docId);
  const beforeVector = Y.encodeStateVector(live);
  humanText(live, 0, { from: 0, to: 0 }, "Human ");
  await ctx.journal.append(docId, Y.encodeStateAsUpdate(live, beforeVector), {
    origin: "human:user-a",
    seq: 0,
  });
  ctx.core.invalidateThread(docId, THREAD_ID);
}
