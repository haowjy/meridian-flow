/**
 * The inbox drain seam: renders a claimed batch into a model request and
 * persists its `message` entries as durable history. A text `message` becomes a
 * user-role message at the request tail and a persisted user-role turn; a
 * child-provenance text message becomes writer-hidden system history with only
 * an exact thread_report reference. A `notice` becomes request-only context.
 *
 * The persisted message turn reuses the durable inbox message id as its turn and
 * block id. The inbox collapses `(threadId, idempotencyKey)` to one row, so a
 * redelivered message reuses the same id and the append is idempotent: turn
 * creation returns the existing row and the block projects through an id-keyed
 * upsert. The loop selects the batch under its thread lock and owns the
 * assistant split and lease receipt around this message materialization.
 *
 * A message whose turn is already durable (a writer send persisted at enqueue,
 * then claimed mid-run) is adopted, not re-persisted. Adoption renders the
 * turn's persisted blocks through the caller's `prepareAdoptedTurn` hook, which
 * resolves any rich content the enqueue transaction could not (text-reference
 * reads) and returns the events to emit, and through `loadActivatedSkillBodies`,
 * which inlines the request-only skill bodies the writer activated on it.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, BlockUpsertedRow, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice, NoticePort } from "../../notices/index.js";
import { system, user } from "../gateway/helpers/messages.js";
import type { Message } from "../gateway/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { attachSkillBodiesToLatestUserMessage, userTurnContentParts } from "./context-builder.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { InboxMessage } from "./ports.js";

/** A request-only skill body inlined onto the activating writer message. */
export interface ActivatedSkillBody {
  slug: string;
  description: string;
  body: string;
}

/** The rich blocks and persisted events an adopted turn's preparation resolved. */
export interface AdoptedTurnPreparation {
  blocks: Block[];
  events: OrchestratorEvent[];
}

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
 * Turns the caller's locked pending batch into model-request
 * context: `message` entries append as user messages and persist as user turns,
 * `notice` entries become request-only notices. A `message` already in
 * `knownTurnIds` was persisted by a crashed run and redelivered, so it is not
 * rendered or appended again. The whole `message` batch persists in one
 * turn-start transition.
 */
export async function drainInbox(input: {
  persistence: PersistenceDeps;
  batch: InboxMessage[];
  notices: NoticePort;
  threadId: ThreadId;
  messages: readonly Message[];
  knownTurnIds: ReadonlySet<TurnId>;
  expectedLeafTurnId: TurnId | null;
  /**
   * Resolves an adopted turn's rich model-facing blocks before it renders (for
   * example, reads text-reference occurrences that lack a persisted result),
   * returning the updated blocks plus the events to emit. A writer send
   * persisted at enqueue has no run yet to read its references at first
   * iteration, so adoption is where its reads land.
   */
  prepareAdoptedTurn?: (turn: Turn, blocks: Block[]) => Promise<AdoptedTurnPreparation>;
  /**
   * Resolves the request-only skill bodies a writer turn activated, read back
   * off its persisted metadata. Applied to the adopted message the turn renders,
   * so a mid-run `/skill` send carries its instructions like a fresh drain does.
   */
  loadActivatedSkillBodies?: (turn: Turn) => Promise<readonly ActivatedSkillBody[]>;
}): Promise<InboxDrain> {
  const batch = input.batch;
  const renderable: InboxMessage[] = [];
  const fresh: InboxMessage[] = [];
  const adoptedTurns: Turn[] = [];
  const adoptedBlocks: Block[] = [];
  const adoptedEvents: OrchestratorEvent[] = [];
  const adoptedBlocksByMessageId = new Map<string, Block[]>();
  const skillBodiesByMessageId = new Map<string, readonly ActivatedSkillBody[]>();
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
    // second append, and carries the turn into the run's accumulator. The
    // adopted blocks render the request, not the plain inbox body: rich content
    // (images, reference reads, skill anchors) lives on the persisted turn.
    const existing = await input.persistence.repos.turns.findById(message.id as TurnId);
    if (existing) {
      let blocks = await input.persistence.repos.blocks.listByTurn(existing.id);
      if (input.prepareAdoptedTurn) {
        const prepared = await input.prepareAdoptedTurn(existing, blocks);
        blocks = prepared.blocks;
        adoptedEvents.push(...prepared.events);
      }
      const skillBodies = await input.loadActivatedSkillBodies?.(existing);
      if (skillBodies?.length) skillBodiesByMessageId.set(message.id, skillBodies);
      adoptedTurns.push(existing);
      adoptedBlocks.push(...blocks);
      adoptedBlocksByMessageId.set(message.id, blocks);
      renderable.push(message);
      continue;
    }
    renderable.push(message);
    fresh.push(message);
  }
  const rendered = renderInboxBatch(
    input.messages,
    renderable,
    adoptedBlocksByMessageId,
    skillBodiesByMessageId,
  );
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
    persistedEvents: [...adoptedEvents, ...persisted.events],
    turns: [...adoptedTurns, ...persisted.turns],
    blocks: [...adoptedBlocks, ...persisted.blocks],
    ackIds: batch.map((message) => message.id),
  };
}

export function renderInboxBatch(
  messages: readonly Message[],
  batch: readonly InboxMessage[],
  adoptedBlocksByMessageId: ReadonlyMap<string, readonly Block[]> = new Map(),
  skillBodiesByMessageId: ReadonlyMap<string, readonly ActivatedSkillBody[]> = new Map(),
): { messages: Message[]; notices: Notice[] } {
  const rendered = [...messages];
  const notices: Notice[] = [];
  for (const message of batch) {
    if (message.intent !== "message") {
      notices.push(inboxMessageNotice(message));
      continue;
    }
    if (message.provenance.kind === "child") {
      rendered.push(system(inboxMessageText(message)));
      continue;
    }
    // A message whose turn is already durable renders that turn's projection;
    // the plain body would drop images, persisted reference reads, and the
    // request-only bodies of the skills the writer activated on it.
    const adopted = adoptedBlocksByMessageId.get(message.id);
    if (adopted) {
      const parts = userTurnContentParts(adopted);
      if (parts.length > 0) {
        const skillBodies = skillBodiesByMessageId.get(message.id);
        const entry: Message = { role: "user", content: parts };
        rendered.push(
          skillBodies?.length
            ? (attachSkillBodiesToLatestUserMessage([entry], skillBodies)[0] as Message)
            : entry,
        );
      }
    } else {
      rendered.push(user(inboxMessageText(message)));
    }
  }
  return { messages: rendered, notices };
}

/**
 * The one planner for "an inbox batch becomes durable message turns": filters
 * `knownTurnIds`, chains each fresh `message` from the previous turn, and emits
 * the `turn.created` + `block.upserted` pair that advances the leaf. Pure, so
 * both the drain start (`runDrainTurn`) and the mid-run drain
 * (`persistInboxMessages`) share one home for chain and idempotency semantics.
 */
export function planMessageTurns(input: {
  batch: readonly InboxMessage[];
  prevTurnId: TurnId | null;
  knownTurnIds: ReadonlySet<TurnId>;
}): {
  turns: Turn[];
  blocks: BlockUpsertedRow[];
  events: OrchestratorEvent[];
  leafTurnId: TurnId | null;
} {
  const turns: Turn[] = [];
  const blocks: BlockUpsertedRow[] = [];
  const events: OrchestratorEvent[] = [];
  let leafTurnId = input.prevTurnId;
  for (const message of input.batch) {
    if (message.intent !== "message") continue;
    if (input.knownTurnIds.has(message.id)) continue;
    const { turn, block } = messageTurnFor(message, leafTurnId);
    turns.push(turn);
    blocks.push(block);
    events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
    leafTurnId = turn.id;
  }
  return { turns, blocks, events, leafTurnId };
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
  if (!input.batch.some((message) => message.intent === "message")) {
    return { turns: [], blocks: [], events: [] };
  }
  // One transition for the whole batch: a mid-batch failure cannot leave a
  // half-persisted batch, and the chain links each message to the previous within
  // the same transaction.
  const persisted = await persistAndAppendTurnStartEvents(
    input.deps,
    input.threadId,
    input.expectedLeafTurnId,
    async () => {
      const plan = planMessageTurns({
        batch: input.batch,
        prevTurnId: input.expectedLeafTurnId,
        knownTurnIds: new Set(),
      });
      return {
        result: { turns: plan.turns, blocks: plan.blocks.map(localBlockFromEvent) },
        events: plan.events,
      };
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
  const isChildNotification = message.provenance.kind === "child";
  const turn = createLocalTurn({
    id: message.id,
    threadId: message.threadId,
    prevTurnId,
    role: isChildNotification ? "system" : "user",
    status: "complete",
    metadata: { kind: "message" },
    createdAt: message.enqueuedAt,
  });
  const text = inboxMessageText(message);
  const block = contentForBlockInput({
    id: message.id,
    turnId: turn.id,
    blockType: "text",
    textContent: text,
    sequence: 0,
    status: "complete",
  });
  return { turn, block };
}

export function inboxMessageText(message: InboxMessage): string {
  switch (message.body.kind) {
    case "text":
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
