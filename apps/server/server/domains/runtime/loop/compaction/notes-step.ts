/** Constructs the durable notes marker after request preparation admits the cycle. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import { compactionNotesMetadata } from "../../../threads/index.js";
import { nextTurnPosition } from "../../../threads/order-turns.js";
import { contentForBlockInput, localBlockFromEvent } from "../block-helpers.js";
import { createLocalTurn } from "../local-turn.js";

export const NOTES_RESERVE_TOKENS = 4_000;
export const MIN_NOTES_ALLOWANCE_TOKENS = 4_000;
export const MAX_NOTES_ALLOWANCE_TOKENS = 32_000;
export const MAX_NOTES_ITERATIONS = 3;

export function prepareCompactionNotes(input: { threadId: ThreadId; turns: Turn[] }): {
  turns: Turn[];
  blocks: Block[];
  events: OrchestratorEvent[];
} {
  const leaf = input.turns.at(-1);
  if (!leaf) throw new Error("Compaction notes step requires a prior turn");
  const turn = createLocalTurn({
    threadId: input.threadId,
    position: nextTurnPosition(leaf),
    prevTurnId: leaf.id,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: compactionNotesMetadata(),
  });
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    sequence: 0,
    textContent:
      "<system_update>\nCompaction starts after this step: earlier turns will be replaced by a summary. Record what you need to continue in your notes under `scratch://$THREAD/` now. Only reads and writes there run until the summary is written; anything else is held. Notes you list first in the summary are shown again in full afterwards, as far as the room allows. Answer without tools when your notes are done.\n</system_update>",
    status: "complete",
  });
  return {
    turns: [turn],
    blocks: [localBlockFromEvent(block)],
    events: [
      { type: "turn.created", turn },
      { type: "block.upserted", block },
    ],
  };
}

/** Only the run loop installs this value, after the prepared boundary commits. */
export type NotesContinuation =
  | { kind: "ordinary" }
  | { kind: "notes"; remaining: number; entryTokens: number; allowance: number }
  | { kind: "compaction_due" };
