/**
 * The inbox drain seam: renders a claimed batch into a model request and
 * persists its `message` entries as durable history. A text `message` becomes a
 * user-role message at the request tail and a persisted user-role turn; a
 * `notice` becomes a request-only notice that never persists a turn. A `report`
 * message (a child's terminal report) persists as a system-role turn carrying a
 * `helper-result` card — the writer's run card — and reaches the model through
 * the shared `componentModelText` projection. Producers are not special-cased;
 * the body decides.
 *
 * The persisted message turn reuses the durable inbox message id as its turn and
 * block id. The inbox collapses `(threadId, idempotencyKey)` to one row, so a
 * redelivered message reuses the same id and the append is idempotent: turn
 * creation returns the existing row and the block projects through an id-keyed
 * upsert. `drainInbox` is the only consumer of the claim; the loop deals in
 * request messages, notices, and persisted events, not inbox rows.
 */
import {
  buildHelperResultComponentContent,
  type HelperResultComponentContent,
} from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  Block,
  BlockUpsertedRow,
  JsonObject,
  OrchestratorEvent,
  Turn,
} from "@meridian/contracts/threads";
import type { Notice, NoticePort } from "../../notices/index.js";
import { system, user } from "../gateway/helpers/messages.js";
import type { Message } from "../gateway/index.js";
import { spawnHelperCardProps } from "../spawn/spawn-output.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { componentModelText } from "./context-builder.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { Inbox, InboxMessage } from "./ports.js";

/** The loop's view of one drained batch: request and notices plus durable writes. */
export interface InboxDrain {
  /** The request messages, with drained `message` entries appended at the tail. */
  rendered: Message[];
  /** Durable notices plus request-only inbox `notice` entries, in batch order. */
  notices: Notice[];
  /** Message-turn persistence events, in batch order. */
  persistedEvents: OrchestratorEvent[];
  /** Persisted message turns/blocks for the loop's in-memory accumulator. */
  turns: Turn[];
  blocks: Block[];
  /** Ids of the whole claimed batch, acked with the response that carries it. */
  ackIds: string[];
}

/**
 * Claims the thread's pending inbox once and turns it into model-request
 * context: `message` entries append as user messages and persist as user turns,
 * `notice` entries become request-only notices. A `message` already in
 * `knownTurnIds` was persisted by a crashed run and redelivered, so it is not
 * rendered or appended again. The whole `message` batch persists in one
 * turn-start transition.
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
  const renderable: InboxMessage[] = [];
  const fresh: InboxMessage[] = [];
  const adoptedTurns: Turn[] = [];
  const adoptedBlocks: Block[] = [];
  for (const message of batch) {
    if (message.intent !== "message") {
      renderable.push(message);
      fresh.push(message);
      continue;
    }
    if (input.knownTurnIds.has(message.id)) continue;
    // A message whose turn is already durable was persisted by the writer
    // producer at enqueue. The drain start sees it through `knownTurnIds`; a
    // mid-run drain does not, so it recognizes the existing turn here, skips the
    // second append, and carries the turn into the run's accumulator.
    const existing = await input.persistence.repos.turns.findById(message.id as TurnId);
    if (existing) {
      adoptedTurns.push(existing);
      adoptedBlocks.push(...(await input.persistence.repos.blocks.listByTurn(existing.id)));
      renderable.push(message);
      continue;
    }
    renderable.push(message);
    fresh.push(message);
  }
  const rendered = renderInboxBatch(input.messages, renderable);
  // Chain fresh messages from the durable leaf so a pre-persisted writer turn
  // (adopted above) is not forked past.
  const persistLeafTurnId = fresh.some((message) => message.intent === "message")
    ? ((await input.persistence.repos.threads.findById(input.threadId))?.activeLeafTurnId ??
      input.expectedLeafTurnId)
    : input.expectedLeafTurnId;
  const persisted = await persistInboxMessages({
    deps: input.persistence,
    threadId: input.threadId,
    expectedLeafTurnId: persistLeafTurnId,
    batch: fresh,
  });
  const notices = [
    ...(await input.notices.drainForModelContext(input.threadId)),
    ...rendered.notices,
  ];
  return {
    rendered: rendered.messages,
    notices,
    persistedEvents: persisted.events,
    turns: [...adoptedTurns, ...persisted.turns],
    blocks: [...adoptedBlocks, ...persisted.blocks],
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
    if (message.intent !== "message") {
      notices.push(inboxMessageNotice(message));
      continue;
    }
    // A report is a system-role card; render it in the same model-facing form
    // the persisted system turn projects, so mid-run delivery matches history.
    if (message.body.kind === "report") {
      const modelText = componentModelText(reportCardContent(message, message.id as TurnId));
      if (modelText) rendered.push(system(modelText));
    } else {
      rendered.push(user(inboxMessageText(message)));
    }
  }
  return { messages: rendered, notices };
}

/**
 * Persists each directed `message` in a claimed batch as a user-role turn at the
 * thread tail. Returns the appended turns/blocks for the loop's in-memory
 * accumulator plus the durable events; `notice` entries are skipped
 * (request-only).
 */
export async function persistInboxMessages(input: {
  deps: PersistenceDeps;
  threadId: ThreadId;
  /** The turn the first `message` follows; each later one follows the previous. */
  expectedLeafTurnId: TurnId | null;
  batch: readonly InboxMessage[];
}): Promise<{ turns: Turn[]; blocks: Block[]; events: OrchestratorEvent[] }> {
  const messages = input.batch.filter((message) => message.intent === "message");
  if (messages.length === 0) return { turns: [], blocks: [], events: [] };
  // One transition for the whole batch: a mid-batch failure cannot leave a
  // half-persisted batch, and the chain links each message to the previous within
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
      for (const message of messages) {
        const { turn, block } = messageTurnFor(message, leafTurnId);
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

/**
 * Builds the durable user turn and text block for one drained `message`. The
 * inbox message id is reused as the turn/block id so a redelivery is idempotent,
 * and `enqueuedAt` (not persist time) stamps the chain order.
 */
export function messageTurnFor(
  message: InboxMessage,
  prevTurnId: TurnId | null,
): { turn: Turn; block: BlockUpsertedRow } {
  const isReportBody = message.body.kind === "report";
  const turn = createLocalTurn({
    id: message.id,
    threadId: message.threadId,
    prevTurnId,
    // A report is writer-facing card history the model reads as a system turn;
    // a text `message` is a user-role message.
    role: isReportBody ? "system" : "user",
    status: "complete",
    metadata: { kind: "message" },
    createdAt: message.enqueuedAt,
  });
  const text = inboxMessageText(message);
  const block = contentForBlockInput({
    id: message.id,
    turnId: turn.id,
    ...(isReportBody
      ? {
          blockType: "custom" as const,
          content: reportCardContent(message, turn.id as TurnId),
        }
      : { blockType: "text" as const, textContent: text }),
    sequence: 0,
    status: "complete",
  });
  return { turn, block };
}

/**
 * The writer-facing `helper-result` card for a drained report, built through the
 * same `spawnHelperCardProps` seam every spawn/child card uses. `childThreadId`
 * comes from the `child` provenance; the message turn is the door's parent.
 */
function reportCardContent(message: InboxMessage, turnId: TurnId): HelperResultComponentContent {
  if (message.body.kind !== "report") {
    throw new Error("reportCardContent requires a report body");
  }
  const body = message.body;
  const childThreadId =
    message.provenance.kind === "child" ? (message.provenance.threadId as string) : undefined;
  const output: JsonObject = body.failed
    ? { status: "error", error: { code: "child_report_failed", message: body.text } }
    : {
        status: "completed",
        report: {
          handle: "",
          threadId: childThreadId ?? "",
          summary: body.text,
          ...(body.artifacts !== undefined ? { artifacts: body.artifacts } : {}),
          ...(body.payload !== undefined ? { payload: body.payload } : {}),
        },
      };
  return buildHelperResultComponentContent(
    spawnHelperCardProps({
      ...(body.agentSlug !== undefined ? { agent: body.agentSlug } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      parentTurnId: turnId,
      ...(childThreadId !== undefined ? { childThreadId } : {}),
      output,
    }),
  );
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
    kind: "inbox_notice",
    scope: { kind: "thread", threadId: message.threadId },
    message: inboxMessageText(message),
    data: {},
    createdAt: new Date(message.enqueuedAt),
  };
}
