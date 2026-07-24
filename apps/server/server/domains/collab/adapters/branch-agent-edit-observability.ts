/** Observability adapter for branch agent-edit diagnostics. */

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
