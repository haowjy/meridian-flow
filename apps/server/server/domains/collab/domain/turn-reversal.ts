/** Turn-level reversal orchestration across every document a thread turn touched. */
import type { ReversalActor, ReversalStore, WriteOutcome } from "@meridian/agent-edit";
import type { DocumentReversalResult, ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { LiveAgentEditCore } from "./agent-edit-cores.js";

export interface ReverseTurnInput {
  threadId: ThreadId;
  turnId: TurnId;
  direction: "undo" | "redo";
  actor: ReversalActor;
  documentIds?: DocumentId[];
}

export interface ReverseTurnDeps {
  reversalStore: ReversalStore;
  agentEdit: Pick<LiveAgentEditCore, "reverse">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  checkDependentLaterLiveRows?(input: {
    documentId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<{ hasDependents: boolean; checkedUntilSeq: number }>;
  refreshDocumentProjection?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  captureInteractionContext?(documentId: DocumentId): Promise<{
    mode: "live";
    baselineSnapshot: Uint8Array;
    liveJournalSeq: number;
  }>;
}

const CANT_UNDO_DEPENDENT_MESSAGE =
  "This turn has later live edits depending on it. View the change instead of undoing it.";
const CANT_UNDO_DEPENDENT_TEXT = `status: cant_undo_dependent\n${CANT_UNDO_DEPENDENT_MESSAGE}`;

export async function reverseTurn(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
): Promise<ReversalOutcome> {
  const documentIds =
    input.documentIds ?? (await deps.reversalStore.documentsForTurn(input.threadId, input.turnId));
  if (documentIds.length === 0) {
    return {
      status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      documents: [],
    };
  }

  const documents: DocumentReversalResult[] = [];
  for (const documentId of documentIds) {
    const outcome = await reverseDocumentForTurn(deps, input, documentId);
    if (isSuccessfulReversal(outcome)) {
      await deps.refreshDocumentProjection?.({
        documentId: documentId as DocumentId,
        threadId: input.threadId,
      });
    }
    documents.push(
      await documentReversalResult({
        documentId,
        outcome,
        resolveDocumentUri: deps.resolveDocumentUri,
      }),
    );
  }

  return { status: aggregateStatus(input.direction, documents), documents };
}

async function reverseDocumentForTurn(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
  documentId: DocumentId,
): Promise<Pick<WriteOutcome, "status" | "text">> {
  const dependencyCheck =
    input.direction === "undo" && input.actor.type === "agent" && deps.checkDependentLaterLiveRows
      ? await deps.checkDependentLaterLiveRows({
          documentId,
          threadId: input.threadId,
          turnId: input.turnId,
        })
      : null;
  if (dependencyCheck?.hasDependents) {
    return {
      status: "cant_undo_dependent",
      text: CANT_UNDO_DEPENDENT_TEXT,
    };
  }
  const interactionContext = await deps.captureInteractionContext?.(documentId);
  return deps.agentEdit.reverse({
    docId: documentId,
    threadId: input.threadId,
    direction: input.direction,
    selection: { kind: "turn", turnId: input.turnId },
    actor: input.actor,
    ...(interactionContext ? { interactionContext } : {}),
  });
}

export async function documentReversalResult(input: {
  documentId: string;
  outcome: Pick<WriteOutcome, "status" | "text">;
  resolveDocumentUri: (documentId: string) => Promise<string | null>;
}): Promise<DocumentReversalResult> {
  return {
    uri: (await input.resolveDocumentUri(input.documentId)) ?? input.documentId,
    status: input.outcome.status,
    ...(input.outcome.text ? { text: input.outcome.text } : {}),
  };
}

export function aggregateStatus(
  direction: "undo" | "redo",
  documents: readonly Pick<DocumentReversalResult, "status">[],
): DocumentReversalResult["status"] {
  const statuses = documents.map((document) => document.status);
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";

  if (statuses.every((status) => status === noOp)) return noOp;
  if (
    statuses.every((status) => status === "reversed" || status === "reconciled" || status === noOp)
  ) {
    return statuses.includes("reconciled") ? "reconciled" : "reversed";
  }
  if (statuses.includes("cant_undo_dependent")) return "cant_undo_dependent";
  if (statuses.every((status) => status === "expired")) return "expired";
  return "partial";
}

export function isSuccessfulReversal(outcome: Pick<WriteOutcome, "status">): boolean {
  return outcome.status === "reversed" || outcome.status === "reconciled";
}
