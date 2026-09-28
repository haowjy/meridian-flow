/** Prepare the source read-only and summarize it for a destination-owned seed. */
import type { Thread, Turn } from "@meridian/contracts/threads";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type HandoffFailureOutcome,
  HandoffSeedMetadataCodec,
  loadThreadConversationContext,
} from "../../threads/index.js";
import type { GenerateRequest } from "../gateway/index.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import { projectActiveHistoryWithBakes } from "./compaction/index.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { prepareRequestContext } from "./request-preparation.js";

export async function generateHandoffBrief(
  deps: OrchestratorDeps,
  thread: Thread,
  seed: Turn,
  signal: AbortSignal,
): Promise<{ outcome: SummaryOutcome; failure?: HandoffFailureOutcome }> {
  let phase: HandoffFailureOutcome["phase"] = "source_prepare";
  try {
    const metadata = HandoffSeedMetadataCodec.parse(seed.metadata);
    const source = await deps.repos.threads.findByIdIncludingDeleted(metadata.sourceThreadId);
    if (!source) throw new Error("Handoff source is missing");
    const context = await loadThreadConversationContext(deps.repos, source, metadata.cutoffTurnId);
    let requestInHand: GenerateRequest | null = null;
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
      if (!prepared.events.length && !prepared.turns.length)
        requestInHand = prepared.assembled.generateRequest;
    } catch (error) {
      signal.throwIfAborted();
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "runtime.handoff",
        name: "preview.cold",
        correlation: { threadId: thread.id, turnId: seed.id },
        payload: unknownToEventPayload(error),
      });
    }
    phase = "summary";
    const outcome = await deps.summarizer.summarize({
      owner: { threadId: thread.id, turnId: seed.id },
      source: { threadId: source.id, throughTurnId: metadata.cutoffTurnId },
      instruction: "handoff_brief",
      incomingAgentName: thread.agentName ?? "the selected Agent",
      requestInHand,
      projection: await projectActiveHistoryWithBakes(
        context.turns,
        context.blocks,
        source.ref,
        deps.repos.promptBakes,
      ),
      signal,
    });
    return {
      outcome,
      ...(outcome.kind === "complete"
        ? {}
        : {
            failure: {
              reason:
                outcome.kind === "failed"
                  ? (outcome.rejectionReason ?? "handoff_brief_failed")
                  : "handoff_brief_failed",
              phase,
            },
          }),
    };
  } catch (error) {
    if (!signal.aborted)
      emitEvent(deps.eventSink, {
        level: "error",
        source: "runtime.handoff",
        name: "brief.failed",
        correlation: { threadId: thread.id, turnId: seed.id },
        payload: unknownToEventPayload(error),
      });
    return {
      outcome: {
        kind: signal.aborted ? "cancelled" : "failed",
        error,
        modelResponses: [],
        summarizer: { path: "cold", segments: 0 },
      },
      failure: { reason: "handoff_brief_failed", phase },
    };
  }
}
