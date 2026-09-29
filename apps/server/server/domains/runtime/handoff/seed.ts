/** Durable seed completion and the frozen handoff-card/system-update projection. */
import type { HandoffBriefProps } from "@meridian/contracts/components";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { Turn } from "@meridian/contracts/threads";
import {
  type HandoffFailureOutcome,
  HandoffFailureOutcomeCodec,
  HandoffSeedMetadataCodec,
  handoffSeedMetadata,
} from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import type { PersistenceDeps } from "../loop/persistence.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import { threadReferenceText } from "../thread-reference.js";

export const handoffBriefUnavailableCopy =
  "This conversation was handed off. No brief is available.";

export function handoffSeedBlock(
  seed: Turn,
  brief?: { text: string; model: string },
  historyReadable = false,
) {
  const metadata = HandoffSeedMetadataCodec.parse(seed.metadata);
  const sourceRef = metadata.sourceRef;
  const reference = historyReadable ? `\n${threadReferenceText({ ref: sourceRef })}` : "";
  const modelText = brief
    ? `<system_update>\n<prior-session-context source="${sourceRef}">\n${brief.text}\n</prior-session-context>${reference}\n</system_update>`
    : `<system_update>\nThis conversation was handed off from ${sourceRef}. No brief is available.${reference}\n</system_update>`;
  const props: HandoffBriefProps = {
    state: brief ? "available" : "unavailable",
    brief: brief?.text ?? null,
    sourceThreadId: metadata.sourceThreadId,
    sourceRef,
    sourceTitle: metadata.sourceTitle,
    cutoffTurnId: metadata.cutoffTurnId,
    model: brief?.model ?? null,
    modelText,
  };
  return contentForBlockInput({
    turnId: seed.id,
    blockType: "custom",
    sequence: 0,
    status: "complete",
    content: { kind: "handoff-brief", props },
  });
}

type HandoffSeedOutcome = {
  summarizer?: import("../ports/conversation-summarizer.js").SummaryOutcome["summarizer"];
  failure?: HandoffFailureOutcome;
  cause?: string;
};

/** Caller holds the destination lock; the event and pending→terminal transition are atomic. */
export async function completeHandoffSeed(
  deps: PersistenceDeps,
  completed: Turn,
  block: ReturnType<typeof handoffSeedBlock>,
  outcome: HandoffSeedOutcome,
): Promise<Turn> {
  const saved = await deps.repos.turns.findById(completed.id);
  if (!saved) throw new Error("Handoff seed disappeared");
  if (saved.status !== "pending") return saved;
  const metadata = await recordHandoffSeedOutcome(deps, saved, outcome);
  completed = { ...completed, metadata: metadata.metadata };
  await persistAndAppendEvents(deps, completed.threadId, async () => ({
    result: undefined,
    events: [
      { type: "block.upserted", block },
      completed.status === "complete"
        ? { type: "turn.completed", turn: completed }
        : completed.status === "cancelled"
          ? { type: "turn.cancelled", turn: completed }
          : {
              type: "turn.error",
              turn: completed,
              error: {
                ...meridianErrorFromSystem("handoff_brief_failed", completed.error ?? ""),
                details: {
                  ...HandoffFailureOutcomeCodec.parse(completed.metadata),
                  ...(outcome.cause ? { cause: outcome.cause } : {}),
                },
              },
            },
    ],
  }));
  return completed;
}

/** One metadata writer; terminal telemetry belongs only to the winning attempt. */
export async function recordHandoffSeedOutcome(
  deps: Pick<PersistenceDeps, "repos">,
  turn: Turn,
  outcome: HandoffSeedOutcome,
): Promise<Turn> {
  if (turn.status !== "pending") return turn;
  const metadata = {
    ...HandoffSeedMetadataCodec.parse(turn.metadata),
    ...(outcome.summarizer ? { summarizer: outcome.summarizer } : {}),
    ...(outcome.failure ?? {}),
  };
  await deps.repos.turns.updateStatus(turn.id, { status: turn.status, metadata });
  return { ...turn, metadata };
}

export function handoffSeedMetadataFrom(seed: Turn): ReturnType<typeof handoffSeedMetadata> {
  const metadata = HandoffSeedMetadataCodec.parse(seed.metadata);
  return handoffSeedMetadata({
    sourceThreadId: metadata.sourceThreadId,
    sourceRef: metadata.sourceRef,
    sourceTitle: metadata.sourceTitle,
    cutoffTurnId: metadata.cutoffTurnId,
  });
}
