import type { AgentEditCore, ReversalStore, WriteOutcome } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import { reverseTurn } from "./turn-reversal.js";

describe("reverseTurn", () => {
  it("reverses each document in a turn and aggregates successful undo", async () => {
    const store = fakeStore({
      documents: ["doc-a", "doc-b"],
      active: {
        "doc-a": [{ handle: "w1", turnId: "turn-1" }],
        "doc-b": [{ handle: "w2", turnId: "turn-1" }],
      },
    });
    const reverse = vi.fn(async ({ docId }) =>
      outcome(docId === "doc-a" ? "reversed" : "nothing_to_undo"),
    );
    const refresh = vi.fn(async () => undefined);

    const result = await reverseTurn(
      {
        reversalStore: store,
        agentEdit: { reverse } as Pick<AgentEditCore, "reverse">,
        resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
        refreshDocumentProjection: refresh,
      },
      { threadId: "thread-1", turnId: "turn-1", direction: "undo", actor: { type: "agent" } },
    );

    expect(reverse).toHaveBeenCalledTimes(2);
    expect(reverse).toHaveBeenNthCalledWith(1, {
      docId: "doc-a",
      threadId: "thread-1",
      direction: "undo",
      selection: { kind: "turn", turnId: "turn-1" },
      actor: { type: "agent" },
    });
    expect(result).toEqual({
      status: "reversed",
      documents: [
        { uri: "manuscript://doc-a.md", status: "reversed", writeIds: ["w1"], text: "reversed" },
        {
          uri: "manuscript://doc-b.md",
          status: "nothing_to_undo",
          writeIds: ["w2"],
          text: "nothing_to_undo",
        },
      ],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps mixed per-document statuses instead of throwing", async () => {
    const store = fakeStore({
      documents: ["doc-a", "doc-b"],
      active: {
        "doc-a": [{ handle: "w1", turnId: "turn-1" }],
        "doc-b": [{ handle: "w2", turnId: "turn-1" }],
      },
    });
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
});

type FakeWrite = { handle: string; turnId: string };

function fakeStore(input: {
  documents: string[];
  active?: Record<string, FakeWrite[]>;
}): ReversalStore {
  return {
    documentsForTurn: async () => input.documents,
    activeWriteSummary: async (documentId) =>
      (input.active?.[documentId] ?? []).map((write, index) => ({
        writeId: `${write.handle}-durable`,
        handle: write.handle,
        wId: index + 1,
        turnId: write.turnId,
        createdSeq: index + 1,
      })),
    readReversals: async () => [],
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

function outcome(status: WriteOutcome["status"]): WriteOutcome {
  return { command: "undo", status, isError: false, text: status };
}
