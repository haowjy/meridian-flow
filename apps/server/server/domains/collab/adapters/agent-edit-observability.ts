/** Event-sink adapters for agent-edit diagnostics and lifecycle observability. */
import type {
  LinkSpliceFallbackDetail,
  LoroEditCoreOptions,
  ObservationFailedDetail,
  UnexpectedWriteErrorDetail,
} from "@meridian/agent-edit/integration";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { DocumentProjectionDiagnostics } from "../domain/document-projection-refresher.js";
import type { ReversalNoticeDiagnostics } from "../domain/reversal-notices.js";

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
  };
}

export function createAgentEditObservabilityOptions(input: {
  eventSink?: EventSink;
}): Pick<
  LoroEditCoreOptions,
  "onUnexpectedWriteError" | "onLinkSpliceFallback" | "onObservationFailed"
> {
  return {
    onUnexpectedWriteError: unexpectedWriteErrorObserver(input.eventSink),
    onLinkSpliceFallback: linkSpliceFallbackObserver(input.eventSink),
    onObservationFailed: observationFailedObserver(input.eventSink),
  };
}

/**
 * A result's observation frontier could not be computed: it goes out without
 * one, and the model's next frontier for the room chains from an older row.
 */
function observationFailedObserver(
  eventSink?: EventSink,
): NonNullable<LoroEditCoreOptions["onObservationFailed"]> {
  return (event: ObservationFailedDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "warn",
      source: "collab.agent_edit",
      name: "observation_frontier.compute_failed",
      correlation: { documentId: event.documentId },
      payload: unknownToEventPayload(event.cause),
    });
  };
}

/**
 * A formatted find whose splice changed how its surroundings parse binds the
 * whole block group (contract §5.4): identity still holds, but unchanged links
 * there may churn their formatting. The only approximation in the write path.
 */
function linkSpliceFallbackObserver(
  eventSink?: EventSink,
): NonNullable<LoroEditCoreOptions["onLinkSpliceFallback"]> {
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
): NonNullable<LoroEditCoreOptions["onUnexpectedWriteError"]> {
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
        ...(event.responseId ? { responseId: event.responseId } : {}),
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...unknownToEventPayload(event.cause),
      },
    });
  };
}
