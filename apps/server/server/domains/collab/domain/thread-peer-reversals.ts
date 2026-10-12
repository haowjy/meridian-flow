// Legacy hosted reversal endpoints; model tools use the immutable inverse service.
import type {
  AgentEditCore,
  ReversalSelection,
  ReversalStore,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { LiveAgentEditCore } from "./agent-edit-cores.js";
import {
  type BranchReversalHistoryReader,
  buildBranchReversalState,
  resolveBranchReversalScope,
} from "./branch-reversal-history.js";
import { type ReversalHistory, type ReversalSide, splitReversal } from "./reversal-routing.js";

/** Both journals' reversible writes, and the Work whose draft holds the drafted ones. */
type Histories = { live: ReversalHistory; draft: ReversalHistory | null; draftWorkId: string };

export function createThreadPeerReversals(input: {
  liveUtilityCore: LiveAgentEditCore;
  coreFor(threadId: string | undefined): Promise<AgentEditCore>;
  /** The thread's Work-draft history: its undo and redo reverse drafted writes there. */
  reversalHistory: BranchReversalHistoryReader;
  /** The live journal's history: its undo and redo reverse live writes live. */
  liveHistory: Pick<ReversalStore, "activeWriteSummary" | "readReversals">;
}) {
  /** Both journals' reversible writes; null for a thread with no drafted history here. */
  async function loadHistories(
    documentId: DocumentId,
    threadId: string | undefined,
  ): Promise<Histories | null> {
    if (!threadId) return null;
    const scope = await resolveBranchReversalScope({
      documentId,
      threadId: threadId as ThreadId,
      ...input.reversalHistory,
    });
    if (!scope) return null;
    const drafted = buildBranchReversalState(threadId as ThreadId, scope.rows);
    const [active, reversals] = await Promise.all([
      input.liveHistory.activeWriteSummary(documentId, threadId),
      input.liveHistory.readReversals(documentId, { threadId }),
    ]);
    return {
      live: { active, reversals },
      draft: { active: drafted.activeWrites, reversals: drafted.reversals },
      draftWorkId: scope.workId,
    };
  }

  /** Where each selected write landed; only a thread with drafted history splits. */
  function routes(
    histories: Histories | null,
    direction: "undo" | "redo",
    selection: ReversalSelection,
  ) {
    if (!histories) return new Map([["live" as const, { selection, handles: [] as string[] }]]);
    return splitReversal({ direction, selection, ...histories });
  }

  function coreAt(side: ReversalSide, threadId: string | undefined) {
    return side === "live" ? Promise.resolve(input.liveUtilityCore) : input.coreFor(threadId);
  }

  /** The view a side's reversal spells in: the Work draft its history was read from, or live. */
  function viewAt(side: ReversalSide, histories: Histories | null, responseId?: string): LinkView {
    const reply = responseId ? { responseId } : {};
    return side === "draft" && histories
      ? { kind: "draft", workId: histories.draftWorkId, ...reply }
      : { kind: "live", ...reply };
  }

  /** The side and core holding the write a plain undo or redo would reverse. */
  async function latest(
    histories: Histories | null,
    threadId: string,
    direction: "undo" | "redo",
  ): Promise<{ core: AgentEditCore; view: LinkView }> {
    const [side = "live"] = routes(histories, direction, { kind: "latest" }).keys();
    return { core: await coreAt(side, threadId), view: viewAt(side, histories) };
  }

  return {
    async getAvailability(docId: string, threadId: string) {
      const histories = await loadHistories(docId as DocumentId, threadId);
      const [{ core: undoCore }, { core: redoCore }] = await Promise.all([
        latest(histories, threadId, "undo"),
        latest(histories, threadId, "redo"),
      ]);
      const undo = await undoCore.getAvailability(docId, threadId);
      const redo = redoCore === undoCore ? undo : await redoCore.getAvailability(docId, threadId);
      return {
        undo: undo.undo,
        redo: redo.redo,
        ...(undo.undoWriteId ? { undoWriteId: undo.undoWriteId } : {}),
        ...(undo.undoTarget ? { undoTarget: undo.undoTarget } : {}),
        ...(redo.redoWriteId ? { redoWriteId: redo.redoWriteId } : {}),
      };
    },

    async undo(docId: string, threadId: string) {
      const histories = await loadHistories(docId as DocumentId, threadId);
      const { core, view } = await latest(histories, threadId, "undo");
      return core.undo(docId, threadId, view);
    },

    async redo(docId: string, threadId: string) {
      const histories = await loadHistories(docId as DocumentId, threadId);
      const { core, view } = await latest(histories, threadId, "redo");
      return core.redo(docId, threadId, view);
    },
  };
}
