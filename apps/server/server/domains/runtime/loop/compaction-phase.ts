/** Runs the unlocked summary, then prepares values for an atomic epoch/successor transition. */

import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { CompactionMetadataCodec } from "../../threads/index.js";
import type { SummaryOutcome, SummaryResponse } from "../ports/conversation-summarizer.js";
import { previousAttemptRejectedAsTooLarge } from "../summary/summary-path.js";
import {
  type CompactionDecision,
  CompactionFailureError,
  CompactionPreparationError,
} from "./compaction/decision.js";
import { projectActiveHistoryWithBakes, projectCompactedHistory } from "./compaction/index.js";
import { changedDocumentUris } from "./compaction-revisions.js";
import {
  completeCompactionCurrent,
  type PreparedCompaction,
  prepareCompactionContext,
  prepareCompactionSuccessor,
} from "./compaction-successor.js";
import { turnContextMessages } from "./context-builder.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import type { PersistenceDeps } from "./persistence.js";
import { prepareRequestContext } from "./request-preparation.js";
import type { RunLoopInput } from "./run-turn-port.js";
import type { DeliveryBoundary } from "./runtime-delivery.js";

export async function executeCompaction({
  deps,
  assertNoResponseScope,
  input,
  thread,
  currentTurn,
  allTurns,
  allBlocks,
  boundary,
  decision,
  recordResponses,
  settleResponses,
}: {
  deps: OrchestratorDeps;
  assertNoResponseScope: () => void;
  input: RunLoopInput;
  thread: Thread;
  currentTurn: Turn;
  allTurns: Turn[];
  allBlocks: Block[];
  boundary: DeliveryBoundary;
  decision: Extract<CompactionDecision, { kind: "compact" }>;
  recordResponses: (rows: SummaryResponse[], summarizer: SummaryOutcome["summarizer"]) => void;
  settleResponses: (rows: SummaryResponse[]) => Promise<void>;
}) {
  const projection = await projectActiveHistoryWithBakes(
    allTurns,
    allBlocks,
    thread.ref,
    deps.repos.promptBakes,
  );
  const changed = await changedDocumentUris({
    threadId: input.threadId,
    projection,
    policies: (name) => deps.toolRegistry.getRegistration(name)?.documentText,
    revisions: deps.documentRevisions,
    assertNoResponseScope,
  });
  let summary: SummaryOutcome;
  try {
    input.signal?.throwIfAborted();
    summary =
      decision.plan.outcome !== "planned" || decision.refusal
        ? {
            kind: "failed",
            error: new CompactionPreparationError(decision.refusal ?? "compaction_failed"),
            modelResponses: [],
            summarizer: { path: "rolling", segments: 0 },
          }
        : await deps.summarizer.summarize({
            owner: { threadId: input.threadId, turnId: currentTurn.id },
            source: { threadId: input.threadId },
            instruction: "compaction",
            writerInstructions: decision.instructions,
            changedDocuments: changed,
            requestInHand: decision.requestInHand,
            knownTooLarge:
              decision.knownTooLarge ??
              previousAttemptRejectedAsTooLarge(allTurns, currentTurn.id, "compaction"),
            retainedMessages: decision.plan.retainedSuffix.flatMap(({ turn, blocks }) =>
              turnContextMessages(
                turn,
                projection.blocks.filter(
                  (block) =>
                    block.turnId === turn.id &&
                    blocks.some((retained) => retained.sequence === block.sequence),
                ),
              ),
            ),
            projection: projectCompactedHistory(projection, decision.plan),
            signal: input.signal ?? new AbortController().signal,
          });
  } catch (error) {
    if (!input.signal?.aborted)
      emitEvent(deps.eventSink, {
        level: "error",
        source: "runtime.compaction",
        name: "summarizer.threw",
        correlation: { threadId: input.threadId, turnId: currentTurn.id },
        payload: unknownToEventPayload(error),
      });
    summary = {
      kind: input.signal?.aborted ? "cancelled" : "failed",
      error,
      modelResponses: [],
      summarizer: { path: "rolling", segments: 0 },
    };
  }
  if (!decision.refusal) recordResponses(summary.modelResponses, summary.summarizer);
  input.signal?.throwIfAborted();
  const outcome = summary;
  const complete = (prepared: PreparedCompaction | undefined, failure: unknown) =>
    completeCompactionCurrent({
      deps,
      threadId: input.threadId,
      placeholder: currentTurn,
      prepared,
      failure,
      settleResponses: () => settleResponses(outcome.modelResponses),
    });
  const successorBoundary = {
    ...boundary,
    current: { kind: "placeholder" as const, complete },
    prepareCurrent: () =>
      prepareCompactionSuccessor({
        deps,
        assertNoResponseScope,
        input,
        thread,
        placeholder: currentTurn,
        allTurns,
        allBlocks,
        decision,
        outcome,
        projection,
      }),
    prepareNextContext: async (
      drain: import("./inbox-context.js").InboxDrain,
      prepared: PreparedCompaction | undefined,
      selection: import("./runtime-delivery.js").DeliveryBoundarySelection,
    ) => {
      if (prepared?.kind === "failed" && decision.trigger === "auto")
        throw new CompactionFailureError(prepared.failure);
      if (prepared?.kind === "usable") return prepareCompactionContext(drain, prepared, selection);
      const completed = { ...currentTurn, status: "error" as const };
      const next = await prepareRequestContext({
        deps,
        thread,
        threadId: input.threadId,
        referenceTurnId: currentTurn.id,
        currentTurnId: currentTurn.id,
        turns: [
          ...allTurns.map((turn) => (turn.id === currentTurn.id ? completed : turn)),
          ...drain.turns,
        ],
        blocks: [...allBlocks, ...drain.blocks],
        baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
        readReferences: false,
        skipCompaction: true,
        pinnedRequestTurnIds: new Set(selection.outstanding.map((row) => row.id)),
        signal: input.signal,
      });
      return {
        events: next.events,
        turns: next.turns,
        blocks: next.blocks,
        requiresSplit: true,
        context: next.assembled,
        compaction: next.compaction,
      };
    },
  };
  const successor = await deps.delivery.splitAndContinue(successorBoundary);
  return {
    successor,
    preparedContext: successor.context,
    summaryBlock:
      successor.preparedCurrent?.kind === "usable"
        ? successor.preparedCurrent.summaryBlock
        : undefined,
  };
}

export async function recordCompactionSummary(
  deps: PersistenceDeps,
  turn: Turn,
  summarizer: SummaryOutcome["summarizer"],
): Promise<void> {
  await deps.repos.turns.updateStatus(turn.id, {
    status: turn.status,
    metadata: { ...CompactionMetadataCodec.parse(turn.metadata), summarizer },
  });
}
