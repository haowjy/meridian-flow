import type { AgentEditCore, ReversalStore, WriteOutcome } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import { reverseTurn, splitActiveTurnWrites } from "./turn-reversal.js";

describe("reverseTurn", () => {
  it("reverses each document in a turn and aggregates successful undo", async () => {
    const store = fakeStore({ documents: ["doc-a", "doc-b"] });
    const reverse = vi.fn(async ({ docId }) =>
      outcome(docId === "doc-a" ? "reversed" : "nothing_to_undo"),
    );
    const refresh = vi.fn(async (_input: { documentId: string; threadId: string }) => undefined);

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse } as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
        refreshDocumentProjection: refresh,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "undo", actor: { type: "agent" } },
    );

    expect(result).toEqual({
      status: "reversed",
      documents: [
        { uri: "manuscript://doc-a.md", status: "reversed", text: "reversed" },
        {
          uri: "manuscript://doc-b.md",
          status: "nothing_to_undo",
          text: "nothing_to_undo",
        },
      ],
    });
    expect(result.documents.map((document) => document.uri)).toEqual([
      "manuscript://doc-a.md",
      "manuscript://doc-b.md",
    ]);
    expect(refresh.mock.calls.map(([input]) => input.documentId)).toEqual(["doc-a"]);
  });

  it("keeps mixed per-document statuses instead of throwing", async () => {
    const store = fakeStore({ documents: ["doc-a", "doc-b"] });
    const reverse = vi
      .fn()
      .mockResolvedValueOnce(outcome("reversed"))
      .mockResolvedValueOnce(outcome("expired"));

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse } as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "undo", actor: { type: "agent" } },
    );

    expect(result.status).toBe("partial");
    expect(result.documents.map((document) => document.status)).toEqual(["reversed", "expired"]);
  });

  it("aggregates all-reversed redo documents as reversed", async () => {
    const store = fakeStore({ documents: ["doc-a", "doc-b"] });
    const reverse = vi.fn(async () => outcome("reversed"));

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse } as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => documentId,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "redo", actor: { type: "agent" } },
    );

    expect(result.status).toBe("reversed");
    expect(result.documents.map((document) => document.status)).toEqual(["reversed", "reversed"]);
  });

  it("redoes each document in a turn and aggregates successful redo", async () => {
    const store = fakeStore({ documents: ["doc-a", "doc-b"] });
    const reverse = vi.fn(async ({ docId }) =>
      outcome(docId === "doc-a" ? "reconciled" : "nothing_to_redo"),
    );
    const refresh = vi.fn(async (_input: { documentId: string; threadId: string }) => undefined);

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse } as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
        refreshDocumentProjection: refresh,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "redo", actor: { type: "agent" } },
    );

    expect(result).toEqual({
      status: "reconciled",
      documents: [
        { uri: "manuscript://doc-a.md", status: "reconciled", text: "reconciled" },
        {
          uri: "manuscript://doc-b.md",
          status: "nothing_to_redo",
          text: "nothing_to_redo",
        },
      ],
    });
    expect(refresh.mock.calls.map(([input]) => input.documentId)).toEqual(["doc-a"]);
  });

  it("splits draft-accept writes from ordinary turn writes", () => {
    const split = splitActiveTurnWrites(
      [
        activeWrite("w1", "tool-call-1", "turn-1"),
        activeWrite("w2", "draft-accept:draft-1:0", "turn-1"),
        activeWrite("w3", "draft-accept:draft-2:0:op:a", "turn-1"),
        activeWrite("w4", "tool-call-2", "turn-2"),
      ],
      "turn-1",
    );

    expect(split.acceptWrites.map((write) => write.handle)).toEqual(["w2", "w3"]);
    expect(split.rawWrites.map((write) => write.handle)).toEqual(["w1"]);
  });

  it("delegates draft-accept undo to the draft lifecycle and keeps raw writes on agent-edit", async () => {
    const store = fakeStore({
      documents: ["doc-a"],
      activeWrites: [
        activeWrite("w1", "tool-call-1", "turn-1"),
        activeWrite("w2", "draft-accept:draft-1:0", "turn-1"),
      ],
    });
    const reverse = vi.fn(async () => outcome("reversed"));
    const undoAcceptedDraft = vi.fn(
      async () => ({ status: "reactivated", draftId: "draft-1" }) as const,
    );

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse } as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => documentId,
        undoAcceptedDraft,
      },
      {
        threadId: "thread-1",
        turnId: "turn-1",
        direction: "undo",
        actor: { type: "user", userId: "user-1" },
      },
    );

    expect(result.status).toBe("reversed");
    expect(undoAcceptedDraft).toHaveBeenCalledWith({
      documentId: "doc-a",
      threadId: "thread-1",
      draftId: "draft-1",
      writeId: "draft-accept:draft-1:0",
      userId: "user-1",
    });
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(reverse).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { kind: "single", to: "w1" } }),
    );
  });

  it("runs draft-scope reversal through the same turn endpoint orchestration", async () => {
    const store = fakeStore({ documents: ["doc-a"] });
    const liveReverse = vi.fn(async () => outcome("nothing_to_undo"));
    const draftReverse = vi.fn(async () => outcome("reversed"));
    const refreshDraft = vi.fn(async () => undefined);

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse: liveReverse } as Pick<AgentEditCore, "reverse">,
        draftAgentEdit: () => ({ reverse: draftReverse }) as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => documentId,
        refreshDraftProjection: refreshDraft,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "undo", actor: { type: "agent" } },
    );

    expect(result.status).toBe("reversed");
    expect(draftReverse).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { kind: "turn", turnId: "turn-1" } }),
    );
    expect(refreshDraft).toHaveBeenCalledWith({ documentId: "doc-a", threadId: "thread-1" });
  });

  it("surfaces draft dependency refusals without inventing a new status", async () => {
    const store = fakeStore({ documents: ["doc-a"] });
    const draftReverse = vi.fn(async () => outcome("cant_undo_dependent"));

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse: async () => outcome("nothing_to_undo") } as Pick<
          AgentEditCore,
          "reverse"
        >,
        draftAgentEdit: () => ({ reverse: draftReverse }) as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => documentId,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "undo", actor: { type: "agent" } },
    );

    expect(result.status).toBe("partial");
    expect(result.documents).toEqual([
      { uri: "doc-a", status: "cant_undo_dependent", text: "cant_undo_dependent" },
    ]);
  });
});

function fakeStore(input: {
  documents: string[];
  activeWrites?: Awaited<ReturnType<ReversalStore["activeWriteSummary"]>>;
}): ReversalStore {
  return {
    documentsForTurn: async () => input.documents,
    activeWriteSummary: async () => input.activeWrites ?? [],
    readReversals: async () => [],
    reversalOpSeqsForHandles: async () => new Set<number>(),
    reserveWriteOrdinal: async () => 1,
    readForReconstruction: async () => ({ checkpoint: null, updates: [] }),
    latestActiveWrite: async () => undefined,
    writeMinCreatedSeq: async () => undefined,
    mutationsForWrite: async () => [],
    mutationsForWrites: async () => new Map(),
    persistUndo: async () => undefined,
    persistRedo: async () => ({ consumed: false }),
  };
}

function activeWrite(handle: string, writeId: string, turnId: string | null) {
  return {
    handle,
    writeId,
    turnId,
    wId: Number(handle.slice(1)),
    createdSeq: Number(handle.slice(1)),
  };
}

function outcome(status: WriteOutcome["status"]): WriteOutcome {
  return { command: "undo", status, isError: false, text: status };
}
