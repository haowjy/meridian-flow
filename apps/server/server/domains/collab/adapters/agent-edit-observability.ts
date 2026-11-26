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
  unscoped(documentId: string): void;
  snapshotMiss(input: { documentId: string; key: string; prepared: boolean }): void;
}

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
        sessionId: event.sessionId,
        ...(event.responseId ? { responseId: event.responseId } : {}),
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...unknownToEventPayload(event.cause),
      },
    });
  };
}
