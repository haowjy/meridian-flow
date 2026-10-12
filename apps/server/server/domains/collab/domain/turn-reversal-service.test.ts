import { modelResult, type ReversalStore } from "@meridian/agent-edit/integration";
import { describe, expect, it, vi } from "vitest";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
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
    vi.fn(async () => ({
      command: "undo",
      status: "reversed",
      isError: false,
      result: modelResult({ command: "undo", status: "reversed" }),
    }));
  const liveReverse =
    input.liveReverse ??
    vi.fn(async () => ({
      command: "undo",
      status: "reversed",
      isError: false,
      result: modelResult({ command: "undo", status: "reversed" }),
    }));
  const refreshDocumentProjection = vi.fn(async () => undefined);
  const resolveContextDocument = vi.fn(async () => ({
    documentId: input.resolvedDocumentId === undefined ? "document-1" : input.resolvedDocumentId,
    uri: "scratch://@original/context.md",
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
    branchReview: { reverseBranchTurns: vi.fn(async () => []) } as never,
    branchJournal: { listJournalRowsForTurn: async () => [] },
    branches: { getBranch: async () => null },
    resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
    listEditedDocumentsForTurn: async () => input.lineage ?? [],
    fileAccess: visibleOnly(input.allowed),
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
  it("owner-gates and filters live lineage before turn reversal", async () => {
    const liveReverse = vi.fn(async () => ({
      command: "undo",
      status: "reversed",
      isError: false,
      result: modelResult({ command: "undo", status: "reversed" }),
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

describe("cross-scope reversal", () => {
  it("does not reverse branch documents excluded by the authorized live lineage", async () => {
    const reverseBranchTurns = vi.fn(async () => []);
    const liveReverse = vi.fn(async () => ({
      command: "undo",
      status: "reversed",
      isError: false,
      result: modelResult({ command: "undo", status: "reversed" }),
    }));
    const service = createTurnReversalService({
      live: {
        reversalStore: { documentsForTurn: async () => [] } as unknown as ReversalStore,
        agentEdit: { reverse: liveReverse } as never,
        resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
        checkDependentLaterLiveRows: async () => ({ hasDependents: false, checkedUntilSeq: 0 }),
        refreshDocumentProjection: async () => undefined,
      },
      agentEdit: { reverse: vi.fn() } as never,
      branchReview: { reverseBranchTurns } as never,
      branchJournal: {
        listJournalRowsForTurn: async () => [{ branchId: "branch-denied" }],
      } as never,
      branches: {
        getBranch: async () => ({ documentId: "denied" }),
      } as never,
      resolveDocumentUri: async (documentId) => `manuscript://${documentId}.md`,
      listEditedDocumentsForTurn: async () => [],
      fileAccess: visibleOnly(),
      threadContext: {
        requireThreadOwner: async () => ({ projectId: "project-1" as never }),
        resolveContextDocument: async () => ({ documentId: null, uri: "scratch://@/missing.md" }),
      },
    });

    await expect(
      service.reverseTurn({
        threadId: "thread-1" as never,
        turnId: "turn-1" as never,
        direction: "undo",
        actor: { type: "user", userId: "user-1" },
        documentIds: ["allowed" as never],
      }),
    ).resolves.toMatchObject({
      status: "reversed",
      documents: [{ uri: "manuscript://allowed.md", status: "reversed" }],
    });
    expect(reverseBranchTurns).toHaveBeenCalledWith(expect.objectContaining({ branchIds: [] }));
    expect(liveReverse).toHaveBeenCalledTimes(1);
  });

  it("does not start a live reversal when the transaction-local branch scope refuses", async () => {
    let liveReversed = false;
    let atomicCalls = 0;
    const atomic = async <T>(operation: () => Promise<T>): Promise<T> => {
      atomicCalls += 1;
      const before = liveReversed;
      try {
        return await operation();
      } catch (cause) {
        liveReversed = before;
        throw cause;
      }
    };
    const service = createTurnReversalService({
      atomic,
      live: {
        reversalStore: {
          documentsForTurn: async () => ["document-live"],
        } as unknown as ReversalStore,
        agentEdit: {
          reverse: async () => {
            liveReversed = true;
            return {
              command: "undo",
              status: "reversed",
              isError: false,
              result: modelResult({ command: "undo", status: "reversed" }),
            };
          },
        } as never,
        resolveDocumentUri: async () => "manuscript://live.md",
        checkDependentLaterLiveRows: async () => ({ hasDependents: false, checkedUntilSeq: 0 }),
        refreshDocumentProjection: async () => undefined,
      },
      agentEdit: { reverse: vi.fn() } as never,
      branchReview: {
        reverseBranchTurns: async () => [
          { status: "cant_undo_dependent", branchId: "branch-1", journalIds: [1] },
        ],
      } as never,
      branchJournal: {
        listJournalRowsForTurn: async () => [{ branchId: "branch-1" }],
      } as never,
      branches: {
        getBranch: async () => ({ branchId: "branch-1", documentId: "document-branch" }),
      } as never,
      resolveDocumentUri: async () => "manuscript://branch.md",
      listEditedDocumentsForTurn: async () => [],
      fileAccess: visibleOnly(),
      threadContext: {
        requireThreadOwner: async () => ({ projectId: "project-1" as never }),
        resolveContextDocument: async () => ({ documentId: null, uri: "scratch://@/missing.md" }),
      },
    });

    await expect(
      service.reverseTurn({
        threadId: "thread-1" as never,
        turnId: "turn-1" as never,
        direction: "undo",
        actor: { type: "user", userId: "user-1" },
      }),
    ).resolves.toMatchObject({ status: "cant_undo_dependent" });
    expect(atomicCalls).toBe(1);
    expect(liveReversed).toBe(false);
  });
});

/** Every document is the writer's to edit, except those outside `visible`. */
function visibleOnly(visible?: ReadonlySet<string>): FileAccess {
  const open = createAllowAllFileAccess();
  return {
    ...open,
    async authorize(principal, target, need) {
      if (visible && target.kind !== "container" && !visible.has(target.documentId)) {
        return {
          denied: true,
          target,
          reason: "not_found",
          level: "none",
          archivedWork: null,
          facts: null,
          destination: null,
          agentChain: null,
        };
      }
      return open.authorize(principal, target, need);
    },
  };
}
