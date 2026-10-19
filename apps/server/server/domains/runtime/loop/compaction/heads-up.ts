/** Durable working-notes reminder, once per raw-history compaction cycle. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import {
  activeCompaction,
  compactionNearMetadata,
  isCompactionNearTurn,
} from "../../../threads/index.js";
import { nextTurnPosition } from "../../../threads/order-turns.js";
import { contentForBlockInput, localBlockFromEvent } from "../block-helpers.js";
import { createLocalTurn } from "../local-turn.js";

export function prepareCompactionHeadsUp(input: { threadId: ThreadId; turns: Turn[] }): {
  turns: Turn[];
  blocks: Block[];
  events: OrchestratorEvent[];
} {
  const latest = activeCompaction(input.turns);
  // A retained-tail reminder can be replayed after the summary in projected history.
  if (
    input.turns.some(
      (turn) => (!latest || turn.position > latest.position) && isCompactionNearTurn(turn),
    )
  ) {
    return { turns: [], blocks: [], events: [] };
  }
  const leaf = input.turns.at(-1);
  if (!leaf) throw new Error("Compaction heads-up requires a prior turn");
  const turn = createLocalTurn({
    threadId: input.threadId,
    position: nextTurnPosition(leaf),
    prevTurnId: leaf.id,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: compactionNearMetadata(),
  });
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    sequence: 0,
    textContent:
      "<system_update>\nThis conversation is getting close to its context limit and will soon be compacted: earlier turns will be replaced by a summary. Before then, write down anything you will need to continue in your working notes (for example a scratch file). Notes you list in the summary are shown again in full afterwards. Then carry on with the task.\n</system_update>",
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
