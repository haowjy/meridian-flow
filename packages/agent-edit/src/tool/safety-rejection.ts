/** Shared agent-facing rendering for every safety-gate refusal path. */
import type { InternalWriteResult } from "./internal-result.js";
import type { SafetyGateResult, SyncedMutationSummary } from "./mutation-commit.js";
import { formatApplyRejection } from "./response-format.js";

type RejectedGate = Extract<SafetyGateResult, { verdict: "reject" }>;

export function formatSafetyRejection(input: {
  docId: string;
  action: "edit" | "undo" | "redo" | "buffered response";
  gate: RejectedGate;
  summary: SyncedMutationSummary;
}): InternalWriteResult {
  const { gate } = input;
  const action = input.action === "edit" ? "edit" : input.action;
  const message =
    gate.reason === "human_conflict"
      ? `Rejected: your ${action} would delete blocks the writer changed since your last read. Affected blocks: [${gate.conflictedBlockHashes.join(", ")}]. Replan from the concurrent echo below.`
      : `This response has no sealed observation for ${input.docId}. Replan from the concurrent echo below, then read in a new response before another destructive change.`;
  return formatApplyRejection({
    status:
      gate.reason === "human_conflict"
        ? "destructive_write_rejected"
        : "rejected_response_requires_reread",
    message,
    echo: input.summary.echo,
    concurrentEdits: input.summary.concurrentEdits,
  });
}
