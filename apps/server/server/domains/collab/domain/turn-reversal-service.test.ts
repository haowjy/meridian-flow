import type { ReversalStore } from "@meridian/agent-edit/integration";
import { describe, expect, it, vi } from "vitest";
import { ReverseThreadContextError } from "../contracts.js";
import { createTurnReversalService } from "./turn-reversal-service.js";

function createService(input: {
  agentReverse?: ReturnType<typeof vi.fn>;
  liveReverse?: ReturnType<typeof vi.fn>;
  lineage?: Array<{ documentId: string }>;
  allowed?: Set<string>;
  resolvedDocumentId?: string | null;
}) {
  const agentReverse =
    input.agentReverse ??
    vi.fn(async () => ({ command: "undo", status: "reversed", isError: false, text: "ok" }));
  const liveReverse =
    input.liveReverse ??
    vi.fn(async () => ({ command: "undo", status: "reversed", isError: false, text: "ok" }));
  const refreshDocumentProjection = vi.fn(async () => undefined);
  const resolveContextDocument = vi.fn(async () => ({
    documentId: input.resolvedDocumentId === undefined ? "document-1" : input.resolvedDocumentId,
  }));
  const service = createTurnReversalService({
    live: {
      reversalStore: { documentsForTurn: async () => [] } as unknown as ReversalStore,
      agentEdit: { reverse: liveReverse } as never,
      resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
      checkDependentLaterLiveRows: async () => ({ hasDependents: false, checkedUntilSeq: 0 }),
      refreshDocumentProjection,
    },
    agentEdit: { reverse: agentReverse } as never,
    branchReview: { reverseBranchTurn: vi.fn() } as never,
    branchJournal: { listJournalRowsForTurn: async () => [] },
    branches: { getBranch: async () => null },
    resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
    listEditedDocumentsForTurn: async () => input.lineage ?? [],
    documentAccess: {
      canAccessDocument: async (_userId, documentId) => input.allowed?.has(documentId) ?? true,
      canAccessProjectDocument: async (_userId, documentId) =>
        input.allowed?.has(documentId) ?? true,
    },
    threadContext: {
      requireThreadOwner: async () => ({ projectId: "project-1" as never }),
      resolveContextDocument,
    },
  });
  return {
    service,
    agentReverse,
    liveReverse,
    refreshDocumentProjection,
    resolveContextDocument,
  };
}

const base = {
  threadId: "thread-1" as never,
  userId: "user-1" as never,
  direction: "undo" as const,
};

describe("reverseThreadContext", () => {
  it("resolves a context document and parses write handles behind the facade", async () => {
    const { service, agentReverse, refreshDocumentProjection } = createService({});

    await expect(
      service.reverseThreadContext({
        ...base,
        uri: "manuscript://chapter.md",
        scope: "write",
        selection: "w7",
        turnId: "" as never,
      }),
    ).resolves.toMatchObject({ status: "reversed" });

    expect(agentReverse).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: "document-1",
        selection: { kind: "single", to: "w7" },
      }),
    );
    expect(refreshDocumentProjection).toHaveBeenCalledWith({
      documentId: "document-1",
      threadId: "thread-1",
    });
  });

  it("rejects invalid write handles before reversal dispatch", async () => {
    const { service, agentReverse, resolveContextDocument } = createService({
      resolvedDocumentId: null,
    });

    await expect(
      service.reverseThreadContext({
        ...base,
        uri: "manuscript://chapter.md",
        scope: "write",
        selection: "bad",
        turnId: "" as never,
      }),
    ).rejects.toEqual(new ReverseThreadContextError("invalid_write", "invalid_write"));
    expect(agentReverse).not.toHaveBeenCalled();
    expect(resolveContextDocument).not.toHaveBeenCalled();
  });

  it("owner-gates and filters live lineage before turn reversal", async () => {
    const liveReverse = vi.fn(async () => ({
      command: "undo",
      status: "reversed",
      isError: false,
      text: "ok",
    }));
    const { service } = createService({
      liveReverse,
      lineage: [{ documentId: "allowed" }, { documentId: "denied" }],
      allowed: new Set(["allowed"]),
    });

    await service.reverseThreadContext({
      ...base,
      scope: "turn",
      selection: "turn-1",
      turnId: "turn-1" as never,
    });

    expect(liveReverse).toHaveBeenCalledTimes(1);
    expect(liveReverse).toHaveBeenCalledWith(
      expect.objectContaining({ docId: "allowed", selection: { kind: "turn", turnId: "turn-1" } }),
    );
  });
});
