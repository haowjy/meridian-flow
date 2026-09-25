/**
 * The inbox drain seam: materializes a claimed batch as durable history and
 * collects request-only notices and skill bodies. A text `message` becomes a
 * persisted turn. Child-provenance messages become structured subagent-update
 * system turns; Work refreshes become durable system updates, and other notices
 * remain request-only user context.
 *
 * The persisted message turn reuses the durable inbox message id as its turn and
 * block id. The inbox collapses `(threadId, idempotencyKey)` to one row, so a
 * redelivered message reuses the same id and the append is idempotent: turn
 * creation returns the existing row and the block projects through an id-keyed
 * upsert. The loop selects the batch under its thread lock and owns the
 * assistant split and lease receipt around this message materialization.
 *
 * A message whose turn is already durable (a writer send persisted at enqueue,
 * then claimed mid-run) is adopted, not re-persisted. `prepareAdoptedTurn`
 * persists its missing text-reference reads; `loadActivatedSkillBodies` loads
 * request-only skill bodies. The shared context assembler owns all rendering,
 * including image projection across the complete request's occurrence budget.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, BlockUpsertedRow, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice, NoticePort } from "../../notices/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import type { ActivatedSkillBody } from "./context-builder.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { InboxMessage } from "./ports.js";
import type { RenderedWorkContext } from "./work-context.js";

/** The rich blocks an adopted turn's preparation resolved. */
export interface AdoptedTurnPreparation {
  blocks: Block[];
}

/** The loop's view of one drained batch: durable writes and request-only context. */
export interface InboxDrain {
  /** Request-only skill bodies keyed by the writer turn that activated them. */
  skillBodiesByTurn: ReadonlyMap<TurnId, readonly ActivatedSkillBody[]>;
  /** Durable notices plus request-only inbox `notice` entries, in batch order. */
  notices: Notice[];
  /** Persisted message turns/blocks for the loop's in-memory accumulator. */
  turns: Turn[];
  blocks: Block[];
  /** Ids of the whole claimed batch, acked with the response that carries it. */
  ackIds: string[];
}

/**
 * Materializes the caller's locked pending batch. Work refresh notices become
 * durable system_update turns; other notices stay request-only. Messages already
 * in `knownTurnIds` are redeliveries and are not appended again. The whole fresh
 * message batch persists in one turn-start transition.
 */
export async function drainInbox(input: {
  persistence: PersistenceDeps;
  batch: InboxMessage[];
  workContext?: RenderedWorkContext;
  notices: NoticePort;
  threadId: ThreadId;
  knownTurnIds: ReadonlySet<TurnId>;
  expectedLeafTurnId: TurnId | null;
  /**
   * Resolves an adopted turn's rich model-facing blocks before it renders (for
   * example, reads text-reference occurrences that lack a persisted result),
   * returning the updated blocks. A writer send
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
  const fresh: InboxMessage[] = [];
  const adoptedTurns: Turn[] = [];
  const adoptedBlocks: Block[] = [];
  const skillBodiesByTurn = new Map<TurnId, readonly ActivatedSkillBody[]>();
  for (const message of batch) {
    if (message.intent !== "message" && message.body.kind !== "work_context_refresh") {
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
      }
      const skillBodies = await input.loadActivatedSkillBodies?.(existing);
      if (skillBodies?.length) skillBodiesByTurn.set(existing.id, skillBodies);
      adoptedTurns.push(existing);
      adoptedBlocks.push(...blocks);
      continue;
    }
    fresh.push(message);
  }
  // Chain fresh messages from the durable leaf so a pre-persisted writer turn
  // (adopted above) is not forked past.
  const persistLeafTurnId = fresh.some(
    (message) => message.intent === "message" || message.body.kind === "work_context_refresh",
  )
    ? ((await input.persistence.repos.threads.findById(input.threadId))?.activeLeafTurnId ??
      input.expectedLeafTurnId)
    : input.expectedLeafTurnId;
  const persisted = await persistInboxMessages({
    deps: input.persistence,
    threadId: input.threadId,
    expectedLeafTurnId: persistLeafTurnId,
    batch: fresh,
    workContext: input.workContext,
  });
  const turnByMessageId = new Map(
    [...adoptedTurns, ...persisted.turns].map((turn) => [turn.id, turn] as const),
  );
  const orderedTurns = batch.flatMap((message) => {
    const turn = turnByMessageId.get(message.id as TurnId);
    return turn ? [turn] : [];
  });
  const notices = [
    ...(await input.notices.drainForModelContext(input.threadId)),
    ...batch
      .filter(
        (message) => message.intent !== "message" && message.body.kind !== "work_context_refresh",
      )
      .map(inboxMessageNotice),
  ];
  return {
    skillBodiesByTurn,
    notices,
    turns: orderedTurns,
    blocks: [...adoptedBlocks, ...persisted.blocks],
    ackIds: batch.map((message) => message.id),
  };
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
  workContext?: RenderedWorkContext;
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
    if (
      message.intent !== "message" &&
      !(message.body.kind === "work_context_refresh" && input.workContext)
    )
      continue;
    if (input.knownTurnIds.has(message.id)) continue;
    const { turn, block } = messageTurnFor(message, leafTurnId, input.workContext);
    turns.push(turn);
    blocks.push(block);
    events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
    if (message.body.kind === "work_context_refresh" && input.workContext) {
      const { current } = input.workContext;
      const { scope } = current.execution;
      events.push({
        type: "work_context.changed",
        turnId: turn.id,
        threadId: message.threadId,
        projectId: current.projectId,
        scope: { workId: scope.workId, workSlug: scope.workSlug },
      });
    }
    leafTurnId = turn.id;
  }
  return { turns, blocks, events, leafTurnId };
}

/**
 * Persists each directed `message` in a claimed batch as a user-role turn at the
 * thread tail. Returns the appended turns/blocks for the loop's in-memory
 * accumulator. Work refresh notices are durable too; other notices are request-only.
 */
export async function persistInboxMessages(input: {
  deps: PersistenceDeps;
  threadId: ThreadId;
  /** The turn the first `message` follows; each later one follows the previous. */
  expectedLeafTurnId: TurnId | null;
  batch: readonly InboxMessage[];
  workContext?: RenderedWorkContext;
}): Promise<{ turns: Turn[]; blocks: Block[] }> {
  if (
    !input.batch.some(
      (message) => message.intent === "message" || message.body.kind === "work_context_refresh",
    )
  ) {
    return { turns: [], blocks: [] };
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
        workContext: input.workContext,
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
  workContext?: RenderedWorkContext,
): { turn: Turn; block: BlockUpsertedRow } {
  const isChildNotification = message.provenance.kind === "child";
  const turn = createLocalTurn({
    id: message.id,
    threadId: message.threadId,
    prevTurnId,
    role: isChildNotification ? "system" : "user",
    status: "complete",
    metadata:
      message.provenance.kind === "child"
        ? {
            kind: "subagent_update",
            handle: message.provenance.handle,
            outcome: message.provenance.outcome,
            execution: message.provenance.reportId,
          }
        : message.body.kind === "work_context_refresh"
          ? { kind: "system_update", section: "work_context" }
          : { kind: "inbox_message" },
    createdAt: message.enqueuedAt,
  });
  const text =
    message.body.kind === "work_context_refresh" && workContext
      ? `<system_update>\n${workContext.text}\n</system_update>`
      : inboxMessageText(message);
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
    case "work_context_refresh":
      return "";
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
