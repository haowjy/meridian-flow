/** Runs the unlocked summary and its retryable, atomic epoch/successor transition. */

import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { Block, ModelResponseReceivedRow, Thread, Turn } from "@meridian/contracts/threads";
import { promptEpochMetadata } from "../../threads/index.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import { beginPromptEpoch } from "./begin-prompt-epoch.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { type CompactionDecision, CompactionPreparationError } from "./compaction/decision.js";
import { estimateRequestTokens, projectActiveHistory } from "./compaction/index.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { persistAndAppendEvents } from "./persistence.js";
import { prepareRequestContext } from "./request-preparation.js";
import type { RunLoopInput } from "./run-turn-port.js";
import type { DeliveryBoundary } from "./runtime-delivery.js";
import { type AssembledNextTurnContext, composeLivePromptBake } from "./turn-context-assembly.js";

export async function executeCompaction({
  deps,
  input,
  thread,
  currentTurn,
  allTurns,
  allBlocks,
  boundary,
  decision,
  recordResponses,
}: {
  deps: OrchestratorDeps;
  input: RunLoopInput;
  thread: Thread;
  currentTurn: Turn;
  allTurns: Turn[];
  allBlocks: Block[];
  boundary: DeliveryBoundary;
  decision: Extract<CompactionDecision, { kind: "compact" }>;
  recordResponses: (rows: ModelResponseReceivedRow[]) => void;
}) {
  const { repos } = deps;
  const projection = projectActiveHistory(allTurns, allBlocks, thread.ref);
  const placeholder = currentTurn;
  const summarizer = deps.summarizer;
  let summary: SummaryOutcome;
  try {
    input.signal?.throwIfAborted();
    summary = await summarizer.summarize({
      threadId: input.threadId,
      turnId: placeholder.id,
      instruction: "compaction",
      requestInHand: decision.requestInHand,
      projection,
      signal: input.signal ?? new AbortController().signal,
    });
  } catch (error) {
    summary = { kind: input.signal?.aborted ? "cancelled" : "failed", error, modelResponses: [] };
  }
  recordResponses(summary.modelResponses);
  const persistSummaryResponses = async () => {
    await persistAndAppendEvents(deps, input.threadId, async () => ({
      result: undefined,
      events: summary.modelResponses.map((response) => ({
        type: "model.response_received" as const,
        response,
      })),
    }));
  };
  if (input.signal?.aborted || summary.kind === "cancelled") {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  const outcome = summary;
  let composed: Awaited<ReturnType<typeof composeLivePromptBake>> | undefined;
  let summaryBlock: ReturnType<typeof contentForBlockInput> | undefined;
  let tokensAfter = 0;
  let usableSummary = false;
  let assembleSuccessor:
    | ((turns: Turn[], blocks: Block[]) => ReturnType<typeof prepareRequestContext>)
    | undefined;
  let preparedContext: AssembledNextTurnContext | undefined;
  function assertFits(context: AssembledNextTurnContext) {
    const estimate = estimateRequestTokens({ request: context.generateRequest, baseline: null });
    if (estimate >= decision.triggerTokens)
      throw new CompactionPreparationError("context_too_large");
    tokensAfter = estimate;
    if (summaryBlock) {
      const content = summaryBlock.content as {
        kind: "compaction";
        props: Record<string, string | number>;
      };
      content.props.tokensAfter = tokensAfter;
    }
  }
  const successor = await deps.delivery.splitAndContinue({
    ...boundary,
    prepareCurrent: async () => {
      usableSummary = false;
      if (outcome.kind !== "complete") throw new CompactionPreparationError("compaction_failed");
      const composition = await composeLivePromptBake({
        thread,
        turns: allTurns,
        blocks: allBlocks,
        agentRevisions: deps.agentRevisions,
        toolRegistry: deps.toolRegistry,
        baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
        promptBakes: repos.promptBakes,
        workContext: deps.workContext,
      }).catch(() => {
        throw new CompactionPreparationError("compaction_failed");
      });
      composed = composition;
      const provisionalBakeId = crypto.randomUUID();
      const provisional = {
        ...placeholder,
        status: "complete" as const,
        promptBakeId: provisionalBakeId,
        metadata: promptEpochMetadata(placeholder.metadata, "compaction"),
      };
      summaryBlock = contentForBlockInput({
        turnId: placeholder.id,
        blockType: "custom",
        sequence: 0,
        status: "complete",
        content: {
          kind: "compaction",
          props: {
            summary: outcome.text,
            model: outcome.model,
            excludedTurnCount: projection.turns.filter(
              (turn) =>
                turn.role !== "compaction" &&
                allTurns.some((raw) => raw.id === turn.id) &&
                !decision.plan.retainedSuffix.some((slice) => slice.turn.id === turn.id),
            ).length,
            tokensBefore: decision.tokensBefore,
            tokensAfter: 0,
          },
        },
      });
      const preparedSummaryBlock = summaryBlock;
      assembleSuccessor = (lateTurns, lateBlocks) =>
        prepareRequestContext({
          deps,
          thread,
          threadId: input.threadId,
          referenceUserTurnId: placeholder.id,
          assistantTurnId: placeholder.id,
          turns: [
            ...allTurns.map((turn) => (turn.id === placeholder.id ? provisional : turn)),
            ...lateTurns,
          ],
          blocks: [...allBlocks, localBlockFromEvent(preparedSummaryBlock), ...lateBlocks],
          baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
          readReferences: false,
          skipCompaction: true,
          signal: input.signal,
          promptBakes: {
            ...repos.promptBakes,
            findById: async (id) =>
              id === provisionalBakeId
                ? {
                    id,
                    ownerThreadId: thread.id,
                    ...composition.bakeContent,
                    createdAt: new Date().toISOString(),
                  }
                : repos.promptBakes.findById(id),
          },
        });
      // A late-arrival failure must not discard a usable summary and rebake.
      const base = await assembleSuccessor([], []);
      assertFits(base.assembled);
      usableSummary = true;
    },
    prepareNextContext: async (drain) => {
      if (!assembleSuccessor) throw new Error("Missing prepared compaction epoch");
      const prepared = await assembleSuccessor(drain.turns, drain.blocks);
      assertFits(prepared.assembled);
      preparedContext = prepared.assembled;
      return {
        events: prepared.events,
        turns: prepared.assembled.imageContextUpdates.turns,
        blocks: prepared.assembled.imageContextUpdates.blocks,
        requiresSplit: true,
      };
    },
    completeCurrent: async () => {
      if (!usableSummary || outcome.kind !== "complete") {
        await persistSummaryResponses();
        const failed = {
          ...placeholder,
          status: "error" as const,
          error: "This conversation couldn't be compacted. Try again.",
          completedAt: new Date().toISOString(),
        };
        await persistAndAppendEvents(deps, input.threadId, async () => ({
          result: undefined,
          events: [
            {
              type: "turn.error",
              turn: failed,
              error: meridianErrorFromSystem("compaction_failed", failed.error),
            },
          ],
        }));
      } else {
        if (!composed || !summaryBlock) throw new Error("Missing prepared compaction successor");
        await beginPromptEpoch(deps, {
          threadId: input.threadId,
          cause: "compaction",
          boundaryTurnId: placeholder.id,
          bake: { compose: composed.bakeContent },
          completion: {
            blocks: [summaryBlock],
            compactionModel: outcome.model,
            metadata: placeholder.metadata,
            modelResponses: outcome.modelResponses,
            events: (bakeId) => [
              {
                type: "context.compacted",
                compactionTurnId: placeholder.id,
                compactedThrough: decision.plan.compactedThrough,
                bakeId,
                model: outcome.model,
                tokensBefore: decision.tokensBefore,
                tokensAfter,
              },
            ],
          },
        });
      }
      const completed = await repos.turns.findById(placeholder.id);
      if (!completed) throw new Error("Compaction placeholder disappeared");
      return completed;
    },
  });
  return {
    successor,
    preparedContext,
    summaryBlock: successor.completed?.status === "complete" ? summaryBlock : undefined,
  };
}
