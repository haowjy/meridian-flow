/** Runs the unlocked summary, then prepares values for an atomic epoch/successor transition. */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { SummaryOutcome, SummaryResponse } from "../ports/conversation-summarizer.js";
import {
  type CompactionDecision,
  CompactionFailureError,
  CompactionPreparationError,
} from "./compaction/decision.js";
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
    summary =
      decision.plan.outcome !== "planned" || decision.refusal
        ? {
            kind: "failed",
            error: new CompactionPreparationError(decision.refusal ?? "nothing_to_compact"),
            modelResponses: [],
            summarizer: { path: "cold", segments: 0 },
          }
        : await deps.summarizer.summarize({
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
  if (!decision.refusal) recordResponses(summary.modelResponses, summary.summarizer);
  input.signal?.throwIfAborted();
  const outcome = summary;
  const complete = (
    prepared: PreparedCompaction | undefined,
    failure: unknown,
    selection: import("./runtime-delivery.js").DeliverySelection,
  ) =>
    completeCompactionCurrent({
      deps,
      threadId: input.threadId,
      placeholder: currentTurn,
      satisfiesControlId: selection.satisfiesControlId,
      prepared,
      failure,
      settleResponses: () => settleResponses(outcome.modelResponses),
    });
  const successorBoundary = {
    ...boundary,
    satisfyPendingCompact: decision.trigger === "auto" && !decision.satisfiesControlId,
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
      selection: import("./runtime-delivery.js").DeliverySelection,
    ) => {
      if (prepared?.kind === "failed" && decision.required)
        throw new CompactionFailureError(prepared.failure);
      if (prepared?.kind === "usable" && !selection.control)
        return prepareCompactionContext(drain, prepared);
      const completed =
        prepared?.kind === "usable"
          ? {
              ...currentTurn,
              status: "complete" as const,
              promptBakeId: prepared.provisionalBakeId,
            }
          : { ...currentTurn, status: "error" as const };
      const next =
        prepared?.kind === "usable"
          ? await prepared.assemble(drain.turns, drain.blocks, selection)
          : await prepareRequestContext({
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
              skipCompaction:
                !selection.control ||
                selection.controls?.some((control) => control.body.kind === "handoff_brief"),
              controls: selection.controls,
              followingBatches: selection.followingBatches,
              failedUndoIds: selection.failedUndoIds,
              continueAfterControls: selection.outstanding.length > 0 || !!selection.continueTask,
              pinnedRequestTurnIds: new Set(selection.outstanding.map((row) => row.id)),
              signal: input.signal,
            });
      return {
        events: next.events,
        undos: next.undos,
        adoptedIds: next.adoptedIds,
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
