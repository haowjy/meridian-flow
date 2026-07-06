/** Turn-level reversal orchestration across every document a thread turn touched. */
import type {
  ActiveWriteSummary,
  AgentEditCore,
  ReversalActor,
  ReversalStore,
  WriteMutationRow,
  WriteOutcome,
} from "@meridian/agent-edit";
import type { DocumentReversalResult, ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { DraftUndoDomainResult } from "./branch-review.js";

const DRAFT_ACCEPT_WRITE_ID_PREFIX = "draft-accept:";

export interface ReverseTurnInput {
  threadId: ThreadId;
  turnId: TurnId;
  direction: "undo" | "redo";
  actor: ReversalActor;
  documentIds?: DocumentId[];
}

export interface ReverseTurnDeps {
  reversalStore: ReversalStore;
  agentEdit: Pick<AgentEditCore, "reverse">;
  draftAgentEdit?(threadId: ThreadId): Pick<AgentEditCore, "reverse"> | null;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  refreshDocumentProjection?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  refreshDraftProjection?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  undoAcceptedDraft?(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    writeId: string;
    userId: UserId;
  }): Promise<DraftUndoDomainResult>;
}

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
  const split =
    input.direction === "undo"
      ? splitActiveTurnWrites(
          await deps.reversalStore.activeWriteSummary(documentId, input.threadId),
          input.turnId,
        )
      : await splitReversedTurnWrites(deps.reversalStore, {
          documentId,
          threadId: input.threadId,
          turnId: input.turnId,
        });

  if (split.acceptWrites.length === 0) {
    const liveOutcome = await deps.agentEdit.reverse({
      docId: documentId,
      threadId: input.threadId,
      direction: input.direction,
      selection: { kind: "turn", turnId: input.turnId },
      actor: input.actor,
    });
    const draftOutcome = await reverseDraftDocumentForTurn(deps, input, documentId);
    return aggregateWriteOutcomes(
      input.direction,
      draftOutcome ? [liveOutcome, draftOutcome] : [liveOutcome],
    );
  }

  const outcomes: Pick<WriteOutcome, "status" | "text">[] = [];
  if (input.direction === "undo") {
    for (const write of split.acceptWrites) {
      outcomes.push(await undoAcceptedDraftWrite(deps, input, documentId, write.writeId));
    }
  } else {
    outcomes.push({
      status: "nothing_to_redo",
      text: "Draft accept redo is handled by re-applying the draft.",
    });
  }

  for (const write of split.rawWrites) {
    outcomes.push(
      await deps.agentEdit.reverse({
        docId: documentId,
        threadId: input.threadId,
        direction: input.direction,
        selection: { kind: "single", to: write.handle },
        actor: input.actor,
      }),
    );
  }

  const draftOutcome = await reverseDraftDocumentForTurn(deps, input, documentId);
  if (draftOutcome) outcomes.push(draftOutcome);

  return aggregateWriteOutcomes(input.direction, outcomes);
}

async function reverseDraftDocumentForTurn(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
  documentId: DocumentId,
): Promise<Pick<WriteOutcome, "status" | "text"> | null> {
  const draftAgentEdit = deps.draftAgentEdit?.(input.threadId);
  if (!draftAgentEdit) return null;
  const outcome = await draftAgentEdit.reverse({
    docId: documentId,
    threadId: input.threadId,
    direction: input.direction,
    selection: { kind: "turn", turnId: input.turnId },
    actor: input.actor,
  });
  if (isSuccessfulReversal(outcome)) {
    await deps.refreshDraftProjection?.({ documentId, threadId: input.threadId });
  }
  return outcome;
}

export function splitActiveTurnWrites(
  writes: readonly ActiveWriteSummary[],
  turnId: TurnId,
): { acceptWrites: ActiveWriteSummary[]; rawWrites: ActiveWriteSummary[] } {
  return splitTurnWrites(
    writes.filter((write) => write.turnId === turnId),
    (write) => write.writeId,
  );
}

async function splitReversedTurnWrites(
  store: ReversalStore,
  input: { documentId: DocumentId; threadId: ThreadId; turnId: TurnId },
): Promise<{ acceptWrites: WriteMutationRow[]; rawWrites: WriteMutationRow[] }> {
  const reversedHandles = new Set<string>();
  for (const reversal of await store.readReversals(input.documentId, {
    threadId: input.threadId,
    status: ["reversed"],
  })) {
    for (const handle of reversal.writeIds) reversedHandles.add(handle);
  }
  if (reversedHandles.size === 0) return { acceptWrites: [], rawWrites: [] };

  const rowsByHandle = await store.mutationsForWrites(input.documentId, input.threadId, [
    ...reversedHandles,
  ]);
  const rows = [...rowsByHandle.values()]
    .flat()
    .filter((row) => row.status === "reversed" && row.turnId === input.turnId);
  return splitTurnWrites(rows, (row) => row.writeId);
}

function splitTurnWrites<T>(
  writes: readonly T[],
  writeIdOf: (write: T) => string,
): { acceptWrites: T[]; rawWrites: T[] } {
  const acceptWrites: T[] = [];
  const rawWrites: T[] = [];
  for (const write of writes) {
    if (writeIdOf(write).startsWith(DRAFT_ACCEPT_WRITE_ID_PREFIX)) acceptWrites.push(write);
    else rawWrites.push(write);
  }
  return { acceptWrites, rawWrites };
}

async function undoAcceptedDraftWrite(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
  documentId: DocumentId,
  writeId: string,
): Promise<Pick<WriteOutcome, "status" | "text">> {
  const draftId = draftIdFromAcceptWriteId(writeId);
  if (!deps.undoAcceptedDraft || !draftId || input.actor.type !== "user") {
    return { status: "internal_error", text: "Draft accept undo is unavailable." };
  }
  const result = await deps.undoAcceptedDraft({
    documentId,
    threadId: input.threadId,
    draftId,
    writeId,
    userId: input.actor.userId as UserId,
  });
  return outcomeFromDraftUndo(result);
}

function draftIdFromAcceptWriteId(writeId: string): string | null {
  const [, draftId] = writeId.split(":");
  return writeId.startsWith(DRAFT_ACCEPT_WRITE_ID_PREFIX) && draftId ? draftId : null;
}

function outcomeFromDraftUndo(
  result: DraftUndoDomainResult,
): Pick<WriteOutcome, "status" | "text"> {
  if (result.status === "not_found") return { status: "nothing_to_undo", text: "nothing_to_undo" };
  return { status: "partial_failure", text: "reversal_failed" };
}

function aggregateWriteOutcomes(
  direction: "undo" | "redo",
  outcomes: readonly Pick<WriteOutcome, "status" | "text">[],
): Pick<WriteOutcome, "status" | "text"> {
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";
  const materialOutcomes = outcomes.filter((outcome) => outcome.status !== noOp);
  const consideredOutcomes = materialOutcomes.length > 0 ? materialOutcomes : outcomes;
  if (consideredOutcomes.length === 1) return consideredOutcomes[0];
  const status = aggregateStatus(direction, consideredOutcomes);
  return {
    status,
    text:
      consideredOutcomes
        .map((outcome) => outcome.text)
        .filter(Boolean)
        .join("\n") || status,
  };
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
  const success = direction === "undo" ? "reversed" : "reconciled";
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";

  if (statuses.every((status) => status === noOp)) return noOp;
  if (statuses.every((status) => status === success || status === noOp)) return success;
  if (statuses.every((status) => status === "reversed" || status === noOp)) return "reversed";
  if (statuses.every((status) => status === "expired")) return "expired";
  return "partial";
}

export function isSuccessfulReversal(outcome: Pick<WriteOutcome, "status">): boolean {
  return outcome.status === "reversed" || outcome.status === "reconciled";
}
