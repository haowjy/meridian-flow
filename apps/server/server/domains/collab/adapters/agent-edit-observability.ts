/** Event-sink adapters for agent-edit diagnostics and lifecycle observability. */
import type {
  createAgentEditCore,
  ResponseLifecycleClaimDiscardedDetail,
  ReversalNoticeFailedDetail,
  ReversalNoticePort,
  UnexpectedWriteErrorDetail,
  WriteIdempotencyHitDetail,
} from "@meridian/agent-edit/integration";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchAgentEditDiagnostics } from "../domain/branch-agent-edit.js";
import type { BranchPullDiagnostics } from "../domain/branch-pulls.js";
import type { SweepProjectionDiagnostics } from "../domain/branch-push-contracts.js";
import type { DocumentProjectionDiagnostics } from "../domain/document-projection-refresher.js";
import type { MarkdownSerializationAnomalyObserver } from "../domain/markdown-document.js";
import type { ResponseTransactionDiagnostics } from "../domain/response-transaction.js";
import type { ReversalNoticeDiagnostics } from "../domain/reversal-notices.js";

export function createBranchPullDiagnostics(eventSink?: EventSink): BranchPullDiagnostics {
  return {
    rerunFailed({ documentId, cause }) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.branch_pull",
        name: "rerun.failed",
        correlation: { documentId },
        payload: unknownToEventPayload(cause),
      });
    },
  };
}

export function createResponseTransactionDiagnostics(
  eventSink?: EventSink,
): ResponseTransactionDiagnostics {
  const emitFailure = (name: string, input: { responseTransactionId: string; cause: unknown }) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.response_transaction",
      name,
      payload: {
        responseTransactionId: input.responseTransactionId,
        ...unknownToEventPayload(input.cause),
      },
    });
  };
  return {
    participantCommitFailed: (input) => emitFailure("participant_commit.failed", input),
    participantReconciliationFailed: (input) =>
      emitFailure("participant_reconciliation.failed", input),
  };
}

export function createBranchAgentEditDiagnostics(
  eventSink?: EventSink,
): BranchAgentEditDiagnostics {
  return {
    stagedWriteNoop(payload) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.branch_agent_edit",
        name: "staged_write.no_durable_journal_row",
        payload,
      });
    },
    mutationLessPendingEntry(payload) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "warn",
        source: "collab.branch_pending_journal",
        name: "mutation_less_entry_dropped",
        payload,
      });
    },
    autoPushUnapplied(payload) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.branch_auto_push",
        name: "auto_push.unapplied",
        payload,
      });
    },
    autoPushFailed({ workDraftBranchId, cause }) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.branch_auto_push",
        name: "auto_push.failed",
        payload: { workDraftBranchId, ...unknownToEventPayload(cause) },
      });
    },
  };
}

export function createAgentEditInvariantDiagnostic(
  eventSink?: EventSink,
): (payload: Record<string, unknown>) => void {
  return (payload) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "invariant_violation",
      payload,
    });
  };
}

export function createSweepProjectionDiagnostics(
  eventSink?: EventSink,
): SweepProjectionDiagnostics {
  return {
    unavailable({ pushId, documentId, cause }) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "warn",
        source: "collab.change_event",
        name: "sweep_projection.unavailable",
        payload: { pushId, documentId, ...unknownToEventPayload(cause) },
      });
    },
  };
}

export function createDocumentProjectionDiagnostics(
  eventSink?: EventSink,
): DocumentProjectionDiagnostics {
  return {
    failed(input) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: input.source,
        name: input.name,
        payload: {
          documentId: input.documentId,
          threadId: input.threadId ?? null,
          ...input.payload,
        },
      });
    },
    payload: unknownToEventPayload,
  };
}

export function createMarkdownSerializationAnomalyObserver(
  eventSink?: EventSink,
): MarkdownSerializationAnomalyObserver {
  return (anomaly) => {
    if (!eventSink) return;
    try {
      emitEvent(eventSink, {
        level: "warn",
        source: "collab.schema",
        name: "serialize.anomaly_observed",
        correlation: { documentId: anomaly.documentId },
        payload: {
          schemaVersion: anomaly.schemaVersion,
          deletedNodeTypes: anomaly.deletedNodeTypes,
          deletedClockCount: anomaly.deletedClockCount,
        },
      });
    } catch {
      // Diagnostic delivery cannot turn a successful serialization into a failure.
    }
  };
}

export function createReversalNoticeDiagnostics(eventSink?: EventSink): ReversalNoticeDiagnostics {
  return {
    documentUriMissing(input) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "warn",
        source: "collab.undo_notifications",
        name: "document_uri_missing",
        payload: input,
      });
    },
    recordFailedAfterDurability(input) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.model_context_notices",
        name: "record_failed_after_durability",
        payload: {
          kind: input.kind,
          threadId: input.threadId,
          documentIds: [...input.documentIds],
          ...(input.responseId ? { responseId: input.responseId } : {}),
          ...(input.affectedBlockHashes
            ? { affectedBlockHashes: [...input.affectedBlockHashes] }
            : {}),
          cause: unknownToEventPayload(input.cause),
        },
      });
    },
    degradedRecordFailedAfterDurability(input) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.model_context_notices",
        name: "degraded_record_failed_after_durability",
        payload: {
          threadId: input.threadId,
          documentIds: [...input.documentIds],
          ...(input.responseId ? { responseId: input.responseId } : {}),
          cause: unknownToEventPayload(input.cause),
        },
      });
    },
  };
}

export function createAgentEditObservabilityOptions(input: {
  eventSink?: EventSink;
  reversalNoticePort?: ReversalNoticePort;
}): Pick<
  Parameters<typeof createAgentEditCore>[0],
  | "reversalNoticePort"
  | "onInvariantViolation"
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onUnexpectedWriteError"
  | "onReversalNoticeFailed"
> {
  return {
    ...(input.reversalNoticePort ? { reversalNoticePort: input.reversalNoticePort } : {}),
    onInvariantViolation: invariantPolicy(input.eventSink),
    onResponseLifecycleError: responseLifecycleObserver(input.eventSink),
    onResponseClaimDiscarded: responseClaimDiscardedObserver(input.eventSink),
    onResponseCommitterTransition: responseCommitterTransitionObserver(input.eventSink),
    onIdempotencyHit: idempotencyHitObserver(input.eventSink),
    onUnexpectedWriteError: unexpectedWriteErrorObserver(input.eventSink),
    onReversalNoticeFailed: reversalNoticeFailedObserver(input.eventSink),
  };
}

function unexpectedWriteErrorObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onUnexpectedWriteError"]> {
  return (event: UnexpectedWriteErrorDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "write.failed",
      correlation: {
        threadId: event.threadId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.documentId ? { documentId: event.documentId } : {}),
        errorCode: "internal_error",
      },
      payload: {
        command: event.command,
        sessionId: event.sessionId,
        ...(event.responseId ? { responseId: event.responseId } : {}),
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...unknownToEventPayload(event.cause),
      },
    });
  };
}

function invariantPolicy(eventSink?: EventSink): (message: string) => void {
  return (message) => {
    if (process.env.NODE_ENV !== "production") throw new Error(message);

    if (eventSink) {
      try {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.agent_edit",
          name: "invariant_violation",
          payload: { message },
        });
      } catch {
        // Invariant reporting is best-effort after production policy has handled it.
      }
    }
  };
}

function responseLifecycleObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onResponseLifecycleError"]> {
  return (event) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "response_lifecycle.error",
      correlation: {
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        errorCode: event.code,
      },
      payload: { ...event },
    });
  };
}

function responseClaimDiscardedObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onResponseClaimDiscarded"]> {
  return (event: ResponseLifecycleClaimDiscardedDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "response_lifecycle.claim_discarded",
      payload: { ...event },
    });
  };
}

function responseCommitterTransitionObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onResponseCommitterTransition"]> {
  return (event) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "info",
      source: "collab.agent_edit",
      name: `response_committer.${event.transition}`,
      correlation: {
        ...(event.threadId ? { threadId: event.threadId } : {}),
      },
      payload: { ...event },
    });
  };
}

function idempotencyHitObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onIdempotencyHit"]> {
  return (event: WriteIdempotencyHitDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "info",
      source: "collab.agent_edit",
      name: "write.idempotency_hit",
      payload: { ...event },
    });
  };
}

function reversalNoticeFailedObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onReversalNoticeFailed"]> {
  return (event: ReversalNoticeFailedDetail) => {
    if (eventSink) {
      try {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.undo_notifications",
          name: "record.failed",
          payload: { ...event },
        });
        return;
      } catch {
        // Notice diagnostics cannot change the already-durable reversal outcome.
      }
    }
  };
}
