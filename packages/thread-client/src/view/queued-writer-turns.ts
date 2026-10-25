/** Projects waiting inbox messages that have no transcript turn yet as queued writer rows. */
import { type Turn, userMessageTurnBlock } from "@meridian/contracts/protocol";
import type { PendingInboxItem } from "@meridian/contracts/threads";
import { baseTurnFields } from "../turns/state-helpers";

/**
 * A message blocked before admission still belongs in the transcript as a queued bubble. The
 * run-state record is the only durable client fact that carries it until the continuation adopts
 * it, so project its summary and replace the projection when the real turn arrives.
 */
export function queuedWriterTurnStandIns(
  threadId: string,
  stored: readonly Turn[],
  waiting: readonly PendingInboxItem[],
): Turn[] {
  const held = new Set(stored.map((turn) => turn.id));
  let prevTurnId = stored.at(-1)?.id ?? null;
  return waiting
    .filter((item) => !held.has(item.id))
    .map((item) => {
      const content = userMessageTurnBlock({ type: "text", text: item.summary });
      const turn: Turn = {
        id: item.id,
        threadId,
        position: item.seq,
        prevTurnId,
        role: "user",
        origin: "writer",
        writeMode: null,
        status: "complete",
        promptBakeId: null,
        finishReason: null,
        error: null,
        model: null,
        provider: null,
        ...baseTurnFields(),
        createdAt: item.enqueuedAt,
        completedAt: item.enqueuedAt,
        blocks: [
          {
            id: `${item.id}_queued_text`,
            turnId: item.id,
            responseId: null,
            blockType: content.blockType,
            sequence: 0,
            textContent: item.summary,
            content: content.content,
            provider: null,
            providerData: null,
            collapsedContent: null,
            executionSide: null,
            status: "complete",
            createdAt: item.enqueuedAt,
          },
        ],
        executionId: null,
        reservedForUserTurnIds: [],
        delivery: null,
        forgottenBy: null,
        siblingIds: [],
        responses: [],
      };
      prevTurnId = turn.id;
      return turn;
    });
}
