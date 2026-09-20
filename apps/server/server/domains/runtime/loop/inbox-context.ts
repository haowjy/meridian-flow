/**
 * The inbox drain seam: renders a claimed batch into a model request and
 * persists its steers as user-role turns. A `steer` becomes a user-role message
 * at the request tail and, because a steer is history (not transient context),
 * a persisted user-role turn at the thread tail; a `system` message becomes a
 * request-only notice that never persists a turn. Producers are not
 * special-cased — the body decides.
 *
 * The persisted steer turn reuses the durable inbox message id as its turn and
 * block id. The inbox collapses `(threadId, idempotencyKey)` to one row, so a
 * redelivered message reuses the same id and the append is idempotent: turn
 * creation returns the existing row and the block projects through an id-keyed
 * upsert. `drainInbox` is the only consumer of the claim; the loop deals in
 * request messages, notices, and persisted events, not inbox rows.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice, NoticePort } from "../../notices/index.js";
import { user } from "../gateway/helpers/messages.js";
import type { Message } from "../gateway/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { Inbox, InboxMessage } from "./ports.js";

/** The loop's view of one drained batch: request and notices plus durable writes. */
export interface InboxDrain {
  /** Request messages after steers are appended at the tail. */
  rendered: Message[];
  /** Durable notices plus request-only inbox notices, in batch order. */
  notices: Notice[];
  /** Steer-turn persistence events, in batch order. */
  persistedEvents: OrchestratorEvent[];
  /** Persisted steer turns/blocks for the loop's in-memory accumulator. */
  turns: Turn[];
  blocks: Block[];
  /** Ids of the whole claimed batch, acked with the response that carries it. */
  ackIds: string[];
}

/**
 * Claims the thread's pending inbox once and turns it into model-request
 * context: steers append as user messages and persist as user turns, system
 * messages become request-only notices. A steer already in `knownTurnIds` was
 * persisted by a crashed run and redelivered, so it is not rendered or appended
 * again. The whole steer batch persists in one turn-start transition.
 */
export async function drainInbox(input: {
  persistence: PersistenceDeps;
  inbox: Inbox;
  notices: NoticePort;
  threadId: ThreadId;
  messages: readonly Message[];
  knownTurnIds: ReadonlySet<TurnId>;
  expectedLeafTurnId: TurnId | null;
}): Promise<InboxDrain> {
  const batch = await input.inbox.claimPending(input.threadId);
  const freshBatch = batch.filter(
    (message) => message.intent !== "steer" || !input.knownTurnIds.has(message.id),
  );
  const rendered = renderInboxBatch(input.messages, freshBatch);
  const persisted = await persistInboxSteers({
    deps: input.persistence,
    threadId: input.threadId,
    expectedLeafTurnId: input.expectedLeafTurnId,
    batch: freshBatch,
  });
  const notices = [
    ...(await input.notices.drainForModelContext(input.threadId)),
    ...rendered.notices,
  ];
  return {
    rendered: rendered.messages,
    notices,
    persistedEvents: persisted.events,
    turns: persisted.turns,
    blocks: persisted.blocks,
    ackIds: batch.map((message) => message.id),
  };
}

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
  const steers = input.batch.filter((message) => message.intent === "steer");
  if (steers.length === 0) return { turns: [], blocks: [], events: [] };
  // One transition for the whole batch: a mid-batch failure cannot leave a
  // half-persisted batch, and the chain links each steer to the previous within
  // the same transaction.
  const persisted = await persistAndAppendTurnStartEvents(
    input.deps,
    input.threadId,
    input.expectedLeafTurnId,
    async () => {
      const turns: Turn[] = [];
      const blocks: Block[] = [];
      const events: OrchestratorEvent[] = [];
      let leafTurnId = input.expectedLeafTurnId;
      for (const message of steers) {
        const turn = createLocalTurn({
          id: message.id,
          threadId: input.threadId,
          prevTurnId: leafTurnId,
          role: "user",
          status: "complete",
          metadata: { kind: "steer" },
          // Stamp the durable origin time, not persist time: several steers in
          // one drain can share a millisecond, and `listByThread` sorts by
          // `createdAt`, so persist time could invert the chain after a restart.
          createdAt: message.enqueuedAt,
        });
        const block = contentForBlockInput({
          id: message.id,
          turnId: turn.id,
          blockType: "text",
          sequence: 0,
          textContent: inboxMessageText(message),
          status: "complete",
        });
        turns.push(turn);
        blocks.push(localBlockFromEvent(block));
        events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
        leafTurnId = turn.id;
      }
      return { result: { turns, blocks }, events };
    },
  );
  return {
    turns: persisted.result.turns,
    blocks: persisted.result.blocks,
    events: persisted.events,
  };
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
