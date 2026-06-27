/** Turn-level reversal orchestration across every document a thread turn touched. */
import type { AgentEditCore, ReversalActor, ReversalStore } from "@meridian/agent-edit";
import type {
  DocumentReversalResult,
  TurnReversalOutcome,
  WriteStatus,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";

export interface ReverseTurnInput {
  threadId: ThreadId;
  turnId: TurnId;
  direction: "undo" | "redo";
  actor: ReversalActor;
}

export interface ReverseTurnDeps {
  reversalStore: ReversalStore;
  agentEdit: Pick<AgentEditCore, "reverse">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  refreshDocumentProjection?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
}

export async function reverseTurn(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
): Promise<TurnReversalOutcome> {
  const documentIds = await deps.reversalStore.documentsForTurn(input.threadId, input.turnId);
  if (documentIds.length === 0) {
    return {
      status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      documents: [],
    };
  }

  const documents: DocumentReversalResult[] = [];
  for (const documentId of documentIds) {
    const writeIds = await writeIdsForDocument(deps.reversalStore, {
      documentId,
      threadId: input.threadId,
      turnId: input.turnId,
      direction: input.direction,
    });
    const outcome = await deps.agentEdit.reverse({
      docId: documentId,
      threadId: input.threadId,
      direction: input.direction,
      selection: { kind: "turn", turnId: input.turnId },
      actor: input.actor,
    });
    if (outcome.status === "reversed" || outcome.status === "reconciled") {
      await deps.refreshDocumentProjection?.({
        documentId: documentId as DocumentId,
        threadId: input.threadId,
      });
    }
    documents.push({
      uri: (await deps.resolveDocumentUri(documentId)) ?? documentId,
      status: outcome.status,
      writeIds,
      ...(outcome.text ? { text: outcome.text } : {}),
    });
  }

  return { status: aggregateStatus(input.direction, documents), documents };
}

async function writeIdsForDocument(
  store: ReversalStore,
  input: {
    documentId: string;
    threadId: string;
    turnId: string;
    direction: "undo" | "redo";
  },
): Promise<string[]> {
  if (input.direction === "undo") {
    return (await store.activeWriteSummary(input.documentId, input.threadId))
      .filter((write) => write.turnId === input.turnId)
      .map((write) => write.handle);
  }

  const handles = new Set<string>();
  for (const reversal of await store.readReversals(input.documentId, {
    threadId: input.threadId,
    status: ["reversed"],
  })) {
    if (reversal.turnId !== input.turnId) continue;
    for (const writeId of reversal.writeIds) handles.add(writeId);
  }
  return [...handles].sort(compareWriteHandle);
}

function aggregateStatus(
  direction: "undo" | "redo",
  documents: readonly Pick<DocumentReversalResult, "status">[],
): WriteStatus {
  const statuses = documents.map((document) => document.status);
  const success = direction === "undo" ? "reversed" : "reconciled";
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";

  if (statuses.every((status) => status === noOp)) return noOp;
  if (statuses.every((status) => status === success || status === noOp)) return success;
  if (statuses.every((status) => status === "expired")) return "expired";
  return "partial";
}

function compareWriteHandle(left: string, right: string): number {
  const leftNumber = Number(left.replace(/^w/, ""));
  const rightNumber = Number(right.replace(/^w/, ""));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right);
}
