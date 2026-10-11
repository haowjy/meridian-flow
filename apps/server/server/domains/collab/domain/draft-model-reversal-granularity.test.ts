/** Writer evidence protects physical per-change independence through the real write harness. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";

it("two chats can prepare draft undo concurrently without reusing restoration identity", async () => {
  const model = yProsemirrorModel(buildDocumentSchema());
  const h = createWriteToolHarness(
    { "chapter.md": "Alpha sword.\n\nBeta shield." },
    { segmentDraftWrites: true },
  );
  for (const [threadId, find, content] of [
    ["chat-a", "sword", "blade"],
    ["chat-b", "shield", "buckler"],
  ]) {
    expect(
      (
        await h.core.write(
          { command: "replace", file: "chapter.md", find, content },
          { sessionId: threadId, threadId, turnId: threadId },
        )
      ).isError,
    ).toBe(false);
  }
  const beforeUndo = Y.encodeStateAsUpdate(h.liveDoc("chapter.md"));
  const prepared: Uint8Array[] = [];
  let release = () => {};
  const bothPrepared = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Draft journal submission stages rather than publishing. Both peers plan from the same cut.
  h.journal.persistUndo = async (_docId, update) => {
    prepared.push(update);
    if (prepared.length === 2) release();
    await bothPrepared;
    return { persisted: true, journalCommitKind: "staged" };
  };
  const outcomes = await Promise.all(
    ["chat-a", "chat-b"].map((threadId) =>
      h.core.write(
        { command: "undo", file: "chapter.md" },
        { sessionId: threadId, threadId, turnId: `undo-${threadId}` },
      ),
    ),
  );
  expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
  for (const updates of [prepared, [...prepared].reverse()]) {
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, beforeUndo);
    for (const update of updates) Y.applyUpdate(peer, update);
    expect(model.getBlocks(toDocHandle(peer)).map((block) => model.getText(block))).toEqual([
      "Alpha sword.",
      "Beta shield.",
    ]);
    expect(peer.store.pendingStructs).toBeNull();
    expect(peer.store.pendingDs).toBeNull();
    peer.destroy();
  }
});

it("keeps all paragraph rows under one handle and reverses/restores every row", async () => {
  const { activeBranchAgentWriteRows, buildBranchReversalState } = await import(
    "./branch-reversal-history.js"
  );
  const model = yProsemirrorModel(buildDocumentSchema());
  const h = createWriteToolHarness(
    { "chapter.md": "She climbs the road.\n\nShe watches the valley." },
    { segmentDraftWrites: true },
  );
  const threadId = "chat";
  const result = await h.core.write(
    {
      command: "replace",
      file: "chapter.md",
      in: [1, 2],
      content: "I climb the road.\n\nI watch the valley.",
    },
    { sessionId: threadId, threadId, turnId: "pov" },
  );
  expect(result.result.status).toBe("success");
  const entries = h.journal.recordedBatchEntries().at(-1) ?? [];
  const rows = entries.map((entry, index) => ({
    id: index + 1,
    branchId: "work",
    generation: 1,
    source: "agent" as const,
    threadId: threadId as never,
    turnId: "pov" as never,
    wId: entry.mutation?.wId ?? null,
    toolCallId: null,
    actorUserId: null,
    updateData: entry.update,
    updateMeta: entry.meta,
    draftBaseUpdateSeq: 0,
    status: "active" as const,
  }));
  expect(activeBranchAgentWriteRows(rows)).toHaveLength(2);
  const state = buildBranchReversalState(threadId as never, rows);
  expect(state.activeWrites).toHaveLength(1);
  expect(state.mutationsByHandle.get("w1")).toHaveLength(2);
  expect(
    (
      await h.core.write(
        { command: "undo", file: "chapter.md", to: "w1" },
        { sessionId: threadId, threadId, turnId: "undo" },
      )
    ).isError,
  ).toBe(false);
  expect(
    model.getBlocks(toDocHandle(h.liveDoc("chapter.md"))).map((block) => model.getText(block)),
  ).toEqual(["She climbs the road.", "She watches the valley."]);
  expect(
    (
      await h.core.write(
        { command: "redo", file: "chapter.md", last: 1 },
        { sessionId: threadId, threadId, turnId: "redo" },
      )
    ).isError,
  ).toBe(false);
  expect(
    model.getBlocks(toDocHandle(h.liveDoc("chapter.md"))).map((block) => model.getText(block)),
  ).toEqual(["I climb the road.", "I watch the valley."]);
});
