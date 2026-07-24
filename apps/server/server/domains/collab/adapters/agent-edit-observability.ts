/** Event-sink adapters for agent-edit diagnostics and lifecycle observability. */
import type {
  createAgentEditCore,
  ResponseLifecycleClaimDiscardedDetail,
  ReversalNoticeFailedDetail,
  ReversalNoticePort,
  WriteIdempotencyHitDetail,
} from "@meridian/agent-edit/integration";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchAgentEditDiagnostics } from "../domain/branch-agent-edit.js";

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
      if (!eventSink) {
        console.error("Branch auto-push resolved without applying", payload);
        return;
      }
      emitEvent(eventSink, {
        level: "error",
        source: "collab.branch_auto_push",
        name: "auto_push.unapplied",
        payload,
      });
    },
    autoPushFailed({ workDraftBranchId, cause }) {
      if (!eventSink) {
        console.error("Branch auto-push failed", { workDraftBranchId, cause });
        return;
      }
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
  | "onReversalNoticeFailed"
> {
  return {
    ...(input.reversalNoticePort ? { reversalNoticePort: input.reversalNoticePort } : {}),
    onInvariantViolation: invariantPolicy(input.eventSink),
    onResponseLifecycleError: responseLifecycleObserver(input.eventSink),
    onResponseClaimDiscarded: responseClaimDiscardedObserver(input.eventSink),
    onResponseCommitterTransition: responseCommitterTransitionObserver(input.eventSink),
    onIdempotencyHit: idempotencyHitObserver(input.eventSink),
    onReversalNoticeFailed: reversalNoticeFailedObserver(input.eventSink),
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
      } catch (cause) {
        console.error(message, cause);
      }
      return;
    }

    console.error(message);
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
      } catch (cause) {
        console.error("agent-edit undo notification recording failed", event, cause);
        return;
      }
    }
    console.error("agent-edit undo notification recording failed", event);
  };
}
