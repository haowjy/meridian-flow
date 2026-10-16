/** Event-sink adapters for agent-edit diagnostics and lifecycle observability. */
import type {
  createAgentEditCore,
  LinkSpliceFallbackDetail,
  ResponseLifecycleClaimDiscardedDetail,
  UnexpectedWriteErrorDetail,
  WriteIdempotencyHitDetail,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import {
  type EventSink,
  emitEvent,
  errorMessageOf,
  unknownToEventPayload,
} from "../../observability/index.js";
import type { BranchAgentEditDiagnostics } from "../domain/branch-agent-edit.js";
import type { LateWriterEdits } from "../domain/branch-coordinator.js";
import type { BranchPullDiagnostics } from "../domain/branch-pulls.js";
import type { DocumentProjectionDiagnostics } from "../domain/document-projection-refresher.js";
import type { DraftBranchAheadDiagnostics } from "../domain/draft-branch-ahead-registration.js";
import type { DraftRebaseDiagnostics } from "../domain/draft-rebase.js";
import type { MarkdownSerializationAnomalyObserver } from "../domain/markdown-document.js";
import type { ResponseTransactionDiagnostics } from "../domain/response-transaction.js";
import type { ReversalNoticeDiagnostics } from "../domain/reversal-notices.js";

export function createBranchPullDiagnostics(eventSink?: EventSink): BranchPullDiagnostics {
  return {
    backgroundFailed({ documentId, branchId, cause }) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.branch_pull",
        name: "background.failed",
        correlation: { documentId, ...(branchId ? { branchId } : {}) },
        payload: unknownToEventPayload(cause),
      });
    },
  };
}

/** The rebase's own failures: one event per transition, ids in correlation and a finite code in the payload. */
export function createDraftRebaseDiagnostics(eventSink?: EventSink): DraftRebaseDiagnostics {
  const report = (
    name: string,
    reason: string,
    input: { branchId: string; documentId: DocumentId },
  ) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.draft_rebase",
      name,
      correlation: { documentId: input.documentId, branchId: input.branchId },
      payload: { reason },
    });
  };
  return {
    uninitializedBase: (input) => report("base.uninitialized", "base_uninitialized", input),
    mergeFailed: (input) => report("merge.failed", "merge_failed", input),
  };
}

/**
 * The writer-admission side of the rebase's emitter: what late-peer recovery did with one update. Counts
 * only, never the writer's words. `stale_frame` once per writer frame that touched text a rebase
 * rewrote, including a frame that changed nothing: `count` is what it touched, `written` the typing
 * recovered as its own paragraph, `dropped` the deletions left log-only (D33); `dropped: 0` is a clean recovery.
 */
export function createLateWriterEditsReporter(eventSink?: EventSink) {
  return ({ branchId, documentId, lost, written, dropped }: LateWriterEdits) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "warn",
      source: "collab.draft_rebase",
      name: "late_peer.stale_frame",
      correlation: { documentId, branchId },
      payload: { count: lost, written, dropped },
    });
  };
}

export function createDraftBranchAheadDiagnostics(
  eventSink?: EventSink,
): DraftBranchAheadDiagnostics {
  return {
    registrationFailed({ branchId, cause }) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "warn",
        source: "collab.draft_links",
        name: "registration.failed",
        correlation: { branchId },
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
        ...errorMessageOf(input.cause),
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
    replyPinMismatch(payload) {
      if (!eventSink) return;
      emitEvent(eventSink, {
        level: "error",
        source: "collab.reply_save_fences",
        name: "reply_pin.identity_mismatch",
        correlation: {
          documentId: payload.documentId,
          draftId: payload.pin.draftId,
          peerBranchId: payload.pin.peerBranchId,
          upstreamBranchId: payload.pin.upstreamBranchId,
        },
        payload: { threadId: payload.threadId ?? null, refusal: "integration" },
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

export interface LinkScopeObserver {
  /** `holder()` was asked with no open snapshot: the door never opened a scope. */
  unscoped(documentId: string): void;
  /**
   * A ref, address or asset the snapshot never loaded. `prepared` false means
   * no door ever prepared this snapshot (a door forgot); true is benign, since a
   * concurrent merge between prepare and the synchronous block can add a ref.
   */
  snapshotMiss(input: { documentId: string; key: string; prepared: boolean }): void;
}

/**
 * Spelling outside a scope, or past what a door prepared, falls back to the
 * stored bytes: consistent and round-tripping, but not what a reader should
 * see. Tests fail on a door that forgot; production reports it next to the
 * other serialization anomalies.
 */
export function createLinkScopeObserver(eventSink?: EventSink): LinkScopeObserver {
  const report = (name: string, payload: Record<string, string | boolean>) => {
    if (!eventSink) return;
    try {
      emitEvent(eventSink, { level: "warn", source: "collab.schema", name, payload });
    } catch {
      // Diagnostic delivery cannot turn a successful serialization into a failure.
    }
  };
  return {
    unscoped(documentId) {
      if (process.env.NODE_ENV === "test") {
        throw new Error(`Document ${documentId} spelled links outside a document link scope`);
      }
      report("serialize.link_unscoped", { documentId });
    },
    snapshotMiss({ documentId, key, prepared }) {
      if (!prepared && process.env.NODE_ENV === "test") {
        throw new Error(`Document ${documentId} spelled ${key} from a scope no door prepared`);
      }
      report("serialize.link_snapshot_miss", { documentId, key, prepared });
    },
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
          cause: unknownToEventPayload(input.cause),
        },
      });
    },
  };
}

export function createAgentEditObservabilityOptions(input: {
  eventSink?: EventSink;
}): Pick<
  Parameters<typeof createAgentEditCore>[0],
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onUnexpectedWriteError"
  | "onLinkSpliceFallback"
> {
  return {
    onResponseLifecycleError: responseLifecycleObserver(input.eventSink),
    onResponseClaimDiscarded: responseClaimDiscardedObserver(input.eventSink),
    onResponseCommitterTransition: responseCommitterTransitionObserver(input.eventSink),
    onIdempotencyHit: idempotencyHitObserver(input.eventSink),
    onUnexpectedWriteError: unexpectedWriteErrorObserver(input.eventSink),
    onLinkSpliceFallback: linkSpliceFallbackObserver(input.eventSink),
  };
}

/**
 * A formatted find whose splice changed how its surroundings parse binds the
 * whole block group (contract §5.4): identity still holds, but unchanged links
 * there may churn their formatting. The only approximation in the write path.
 */
function linkSpliceFallbackObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onLinkSpliceFallback"]> {
  return (event: LinkSpliceFallbackDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "info",
      source: "collab.agent_edit",
      name: "write.link_splice_fallback",
      correlation: { documentId: event.documentId },
      payload: { reason: event.reason },
    });
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
