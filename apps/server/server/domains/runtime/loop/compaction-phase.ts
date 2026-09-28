/** Runs the unlocked summary, then prepares values for an atomic epoch/successor transition. */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { SummaryOutcome, SummaryResponse } from "../ports/conversation-summarizer.js";
import type { CompactionDecision } from "./compaction/decision.js";
import { changedDocuments, collectRecordedDocuments } from "./compaction/elide.js";
import { projectActiveHistory, projectCompactedHistory } from "./compaction/index.js";
import { queryCompactionRevisions } from "./compaction-revisions.js";
import {
  completeCompactionCurrent,
  type PreparedCompaction,
  prepareCompactionContext,
  prepareCompactionSuccessor,
} from "./compaction-successor.js";
import type { OrchestratorDeps } from "./orchestrator.js";
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
  const projection = projectActiveHistory(allTurns, allBlocks, thread.ref);
  const policies = (name: string) => deps.toolRegistry.getRegistration(name)?.documentText;
  const recorded = collectRecordedDocuments(
    projection.turns.map((turn) => ({
      turn,
      blocks: projection.blocks.filter((block) => block.turnId === turn.id),
    })),
    policies,
  );
  const current = await queryCompactionRevisions({
    threadId: input.threadId,
    recorded,
    revisions: deps.documentRevisions,
    assertNoResponseScope,
  });
  const changed = [
    ...new Set(changedDocuments(recorded, current).flatMap((ref) => (ref.uri ? [ref.uri] : []))),
  ];
  let summary: SummaryOutcome;
  try {
    input.signal?.throwIfAborted();
    summary = await deps.summarizer.summarize({
      threadId: input.threadId,
      turnId: currentTurn.id,
      instruction: "compaction",
      changedDocuments: changed,
      requestInHand: decision.requestInHand,
      forceCold: decision.path === "cold",
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
      summarizer: { path: "cold", segments: 0 },
    };
  }
  recordResponses(summary.modelResponses, summary.summarizer);
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
    prepareNextContext: prepareCompactionContext,
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
