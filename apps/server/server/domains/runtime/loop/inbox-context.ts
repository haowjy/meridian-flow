/**
 * Renders a claimed inbox batch into a model request and persists its steers as
 * user-role turns. A `steer` becomes a user-role message at the request tail
 * and, because a steer is history (not transient context), a persisted
 * user-role turn at the thread tail; a `system` message becomes a request-only
 * notice that never persists a turn. Producers are not special-cased — the body
 * decides.
 *
 * The persisted steer turn reuses the durable inbox message id as its turn and
 * block id. The inbox collapses `(threadId, idempotencyKey)` to one row, so a
 * redelivered message reuses the same id and the append is idempotent: turn
 * creation returns the existing row and the block projects through an id-keyed
 * upsert.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice } from "../../notices/index.js";
import { user } from "../gateway/helpers/messages.js";
import type { Message } from "../gateway/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { InboxMessage } from "./ports.js";

export function renderInboxBatch(
  messages: readonly Message[],
  batch: readonly InboxMessage[],
): { messages: Message[]; notices: Notice[] } {
  const rendered = [...messages];
  const notices: Notice[] = [];
  for (const message of batch) {
    if (message.intent === "steer") {
      rendered.push(user(inboxMessageText(message)));
    } else {
      notices.push(inboxMessageNotice(message));
    }
  }
  return { messages: rendered, notices };
}

/**
 * Persists each steer in a claimed batch as a user-role turn at the thread tail.
 * Returns the appended turns/blocks for the loop's in-memory accumulator plus
 * the durable events; system messages are skipped (request-only notices).
 */
export async function persistInboxSteers(input: {
  deps: PersistenceDeps;
  threadId: ThreadId;
  /** The turn the first steer follows; each later steer follows the previous. */
  expectedLeafTurnId: TurnId | null;
  batch: readonly InboxMessage[];
}): Promise<{ turns: Turn[]; blocks: Block[]; events: OrchestratorEvent[] }> {
  const turns: Turn[] = [];
  const blocks: Block[] = [];
  const events: OrchestratorEvent[] = [];
  let leafTurnId = input.expectedLeafTurnId;
  for (const message of input.batch) {
    if (message.intent !== "steer") continue;
    const turn = createLocalTurn({
      id: message.id,
      threadId: input.threadId,
      prevTurnId: leafTurnId,
      role: "user",
      status: "complete",
      metadata: { kind: "steer" },
    });
    const block = contentForBlockInput({
      id: message.id,
      turnId: turn.id,
      blockType: "text",
      sequence: 0,
      textContent: inboxMessageText(message),
      status: "complete",
    });
    const persisted = await persistAndAppendTurnStartEvents(
      input.deps,
      input.threadId,
      leafTurnId,
      async () => ({
        result: { turn, block: localBlockFromEvent(block) },
        events: [
          { type: "turn.created", turn },
          { type: "block.upserted", block },
        ],
      }),
    );
    turns.push(persisted.result.turn);
    blocks.push(persisted.result.block);
    events.push(...persisted.events);
    leafTurnId = turn.id;
  }
  return { turns, blocks, events };
}

function inboxMessageText(message: InboxMessage): string {
  switch (message.body.kind) {
    case "text":
    case "report":
      return message.body.text;
    case "context":
      return message.body.parts.map((part) => part.text).join("\n\n");
  }
}

function inboxMessageNotice(message: InboxMessage): Notice {
  return {
    id: message.seq,
    kind: "inbox_system",
    scope: { kind: "thread", threadId: message.threadId },
    message: inboxMessageText(message),
    data: {},
    createdAt: new Date(message.enqueuedAt),
  };
}
