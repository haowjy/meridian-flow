/** Read-only source preparation and source-shaped branch with the summarizer fallback. */
import type { Thread, Turn } from "@meridian/contracts/threads";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type HandoffFailureOutcome,
  HandoffSeedMetadataCodec,
  loadThreadConversationContext,
} from "../../threads/index.js";
import type { GenerateRequest } from "../gateway/index.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import { projectActiveHistoryWithBakes } from "../loop/compaction/index.js";
import type { OrchestratorDeps } from "../loop/orchestrator.js";
import { prepareRequestContext } from "../loop/request-preparation.js";

export async function generateHandoffBrief(
  deps: OrchestratorDeps,
  destination: Thread,
  seed: Turn,
  signal: AbortSignal,
): Promise<{ outcome: SummaryOutcome; failure?: HandoffFailureOutcome }> {
  const metadata = HandoffSeedMetadataCodec.parse(seed.metadata);
  const source = await deps.repos.threads.findByIdIncludingDeleted(metadata.sourceThreadId);
  if (!source) throw new Error("Handoff source is missing");
  const context = await loadThreadConversationContext(deps.repos, source, metadata.cutoffTurnId);
  let requestInHand: GenerateRequest | null = null;
  let preparationFailed = false;
  try {
    const prepared = await prepareRequestContext({
      deps,
      thread: source,
      threadId: source.id,
      referenceTurnId: metadata.cutoffTurnId,
      currentTurnId: seed.id,
      ...context,
      readReferences: false,
      skipCompaction: true,
      signal,
    });
    requestInHand = prepared.assembled.generateRequest;
  } catch (error) {
    signal.throwIfAborted();
    preparationFailed = true;
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.handoff",
      name: "source_prepare.fallback",
      correlation: { threadId: destination.id, turnId: seed.id },
      payload: unknownToEventPayload(error),
    });
  }
  const outcome = await deps.summarizer.summarize({
    owner: { threadId: destination.id, turnId: seed.id },
    source: { threadId: source.id, throughTurnId: metadata.cutoffTurnId },
    instruction: "handoff",
    incomingAgentName: destination.agentName ?? "the selected Agent",
    requestInHand,
    path: requestInHand ? "branch" : "rolling",
    projection: await projectActiveHistoryWithBakes(
      context.turns,
      context.blocks,
      source.ref,
      deps.repos.promptBakes,
    ),
    signal,
  });
  if (outcome.kind === "complete" || outcome.kind === "cancelled") return { outcome };
  return {
    outcome,
    failure: {
      reason: outcome.rejectionReason ?? "handoff_brief_failed",
      phase: preparationFailed ? "source_prepare" : "summary",
    },
  };
}
