/** Frozen model context for a handoff seed, including the no-brief terminal states. */
import type { Turn } from "@meridian/contracts/threads";
import { HandoffSeedMetadataCodec, handoffSeedMetadata } from "../../threads/index.js";
import { contentForBlockInput } from "./block-helpers.js";
import type { ControlMessage } from "./control-barrier.js";
import { createLocalTurn } from "./local-turn.js";

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
