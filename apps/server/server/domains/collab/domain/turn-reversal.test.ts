import type { AgentEditCore, ReversalStore, WriteOutcome } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import { reverseTurn } from "./turn-reversal.js";

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
});

function fakeStore(input: { documents: string[] }): ReversalStore {
  return {
    documentsForTurn: async () => input.documents,
    activeWriteSummary: async () => [],
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
