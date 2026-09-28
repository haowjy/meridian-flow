/** Frozen model context for a handoff seed, including the no-brief terminal states. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { Turn } from "@meridian/contracts/threads";
import {
  HandoffFailureOutcomeCodec,
  HandoffSeedMetadataCodec,
  handoffSeedMetadata,
} from "../../threads/index.js";
import { contentForBlockInput } from "./block-helpers.js";
import type { ControlMessage } from "./control-barrier.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";

export const handoffBriefFailedCopy = "This handoff brief couldn't be generated. Try again.";

export async function reserveHandoffSeed(
  repos: Pick<import("../../threads/index.js").ThreadRepositories, "turns" | "threads">,
  input: Turn,
  control: ControlMessage,
  thread: import("@meridian/contracts/threads").Thread,
) {
  const cutoff = thread.originTurnId ? await repos.turns.findById(thread.originTurnId) : null;
  if (!cutoff) throw new Error("Handoff cutoff is missing");
  const source = await repos.threads.findByIdIncludingDeleted(cutoff.threadId);
  if (!source) throw new Error("Handoff source is missing");
  return createLocalTurn({
    ...input,
    prevTurnId: input.prevTurnId ?? null,
    role: "system",
    origin: "system",
    status: "pending",
    metadata: handoffSeedMetadata({
      sourceThreadId: source.id,
      sourceRef: source.ref ?? source.id,
      cutoffTurnId: cutoff.id,
      controlMessageId: control.id,
    }),
  });
}

export function handoffSeedBlock(seed: Turn, brief?: { text: string; model: string }) {
  const metadata = HandoffSeedMetadataCodec.parse(seed.metadata);
  const sourceRef = metadata.sourceRef;
  const modelText = brief
    ? `<system_update>\n<prior-session-context source="${sourceRef}">\n${brief.text}\n</prior-session-context>\n</system_update>`
    : `<system_update>\nThis conversation was handed off from ${sourceRef}. No brief is available.\n</system_update>`;
  return contentForBlockInput({
    turnId: seed.id,
    blockType: "custom",
    sequence: 0,
    status: "complete",
    content: {
      kind: "handoff-brief",
      props: {
        state: brief ? "available" : "unavailable",
        brief: brief?.text ?? null,
        sourceThreadId: metadata.sourceThreadId,
        sourceRef,
        cutoffTurnId: metadata.cutoffTurnId,
        model: brief?.model ?? null,
        modelText,
      },
    },
  });
}

export class HandoffSeedSettledError extends Error {
  constructor(readonly turn: Turn) {
    super("The handoff seed was settled while its brief was running");
  }
}

/** The caller holds the thread lock. Stop can settle a seed after its lease expires. */
export async function completeHandoffSeed(
  deps: PersistenceDeps,
  completed: Turn,
  block: ReturnType<typeof handoffSeedBlock>,
): Promise<Turn> {
  const saved = await deps.repos.turns.findById(completed.id);
  if (saved && saved.status !== "pending") throw new HandoffSeedSettledError(saved);
  await persistAndAppendEvents(deps, completed.threadId, async () => ({
    result: undefined,
    events: [
      { type: "block.upserted", block },
      completed.status === "complete"
        ? { type: "turn.completed", turn: completed }
        : {
            type: "turn.error",
            turn: completed,
            error: {
              ...meridianErrorFromSystem("handoff_brief_failed", completed.error ?? ""),
              details: HandoffFailureOutcomeCodec.parse(completed.metadata),
            },
          },
    ],
  }));
  return completed;
}

export async function recordHandoffSummary(
  deps: PersistenceDeps,
  turn: Turn,
  summarizer: import("../ports/conversation-summarizer.js").SummaryOutcome["summarizer"],
): Promise<void> {
  // Terminal seed telemetry belongs to its winning completion, not a stale paid attempt.
  if (turn.status !== "pending") return;
  await deps.repos.turns.updateStatus(turn.id, {
    status: turn.status,
    metadata: { ...HandoffSeedMetadataCodec.parse(turn.metadata), summarizer },
  });
}
