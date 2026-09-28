/**
 * The inbox drain seam: materializes a claimed batch as durable history. A text
 * `message` becomes a persisted turn. Child-provenance messages become
 * structured subagent-update system turns; Work refreshes and every other
 * request-only notice (the delivery boundary's peeked `NoticePort` rows plus
 * non-message inbox
 * entries) become one durable `system_update` turn, so a rebuilt request always
 * reproduces exactly what an earlier request saw -- required for the frozen
 * prefix's Anthropic cache breakpoints (thread AGENTS.md / runtime CONTEXT.md).
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
 * loads missing text-reference reads and activated skill bodies outside the
 * thread lock, returning their events for the adoption transaction.
 * The shared context assembler owns all rendering, including image projection
 * across the complete request's occurrence budget.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, BlockUpsertedRow, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice } from "../../notices/index.js";
import {
  childCompletionMetadata,
  inboxMessageMetadata,
  noticesMetadata,
  workUpdateMetadata,
} from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { formatNotices } from "./context-builder.js";
import { createLocalTurn } from "./local-turn.js";
import type { PersistenceDeps } from "./persistence.js";
import type { InboxMessage } from "./ports.js";
import type { RenderedWorkContext } from "./work-context.js";

/** The rich blocks (and any hidden sibling turns) an adopted turn's preparation resolved. */
export interface AdoptedTurnPreparation {
  blocks: Block[];
  events?: OrchestratorEvent[];
  /**
   * Hidden turns (with their own blocks) to render immediately after the
   * adopted turn -- for example, a skill-body turn. Never a block on the
   * adopted turn itself: anything that projects a user turn's text (chat
   * previews, `UserTurn.tsx`) concatenates every text block on it, so
   * model-only content must live on its own turn.
   */
  extraTurns?: readonly { turn: Turn; blocks: readonly Block[] }[];
}

/** The loop's view of one drained batch: durable turns/blocks for the loop's in-memory accumulator. */
export interface InboxDrain {
  /** Persisted message/notice/subagent-update turns, in batch order plus a trailing notices turn. */
  turns: Turn[];
  blocks: Block[];
  /** Prepared durable changes; callers commit these after all context reads finish. */
  events: OrchestratorEvent[];
  /** Ids of the whole claimed batch, acked with the response that carries it. */
  ackIds: string[];
}

/**
 * Materializes the caller's locked pending batch. Work refresh notices and every
 * other request-only notice become one durable `system_update` turn; messages
 * already in `knownTurnIds` are redeliveries and are not appended again. The
 * whole fresh message batch (plus the notices turn) persists in one turn-start
 * transition.
 */
export async function drainInbox(input: {
  persistence: PersistenceDeps;
  batch: InboxMessage[];
  workContext?: RenderedWorkContext;
  /**
   * Peeked `NoticePort` notices for this thread. The prepare/commit boundary
   * consumes their selected IDs only when it persists the matching turn.
   */
  notices: readonly Notice[];
  threadId: ThreadId;
  knownTurnIds: ReadonlySet<TurnId>;
  expectedLeafTurnId: TurnId | null;
  /**
   * Resolves an adopted turn's rich model-facing blocks before it renders (for
   * example, reads text-reference occurrences that lack a persisted result, or
   * loads a mid-run steer's activated skill bodies), returning the updated
   * blocks. A writer send persisted at enqueue has no run yet to resolve these
   * at first iteration, so adoption is where they land.
   */
  prepareAdoptedTurn?: (turn: Turn, blocks: Block[]) => Promise<AdoptedTurnPreparation>;
}): Promise<InboxDrain> {
  const batch = input.batch;
  const fresh: InboxMessage[] = [];
  // Keyed by message id, in final render order per message: the adopted turn
  // itself plus any hidden sibling turns prepared for it.
  const adoptedTurnsByMessageId = new Map<string, Turn[]>();
  const adoptedBlocks: Block[] = [];
  const adoptedEventsByMessageId = new Map<string, OrchestratorEvent[]>();
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
      const extraTurns: Turn[] = [];
      if (input.prepareAdoptedTurn) {
        const prepared = await input.prepareAdoptedTurn(existing, blocks);
        blocks = prepared.blocks;
        adoptedEventsByMessageId.set(message.id, [...(prepared.events ?? [])]);
        for (const extra of prepared.extraTurns ?? []) {
          extraTurns.push(extra.turn);
          adoptedBlocks.push(...extra.blocks);
          adoptedEventsByMessageId.get(message.id)?.push(
            { type: "turn.created", turn: extra.turn },
            ...extra.blocks.map((block) => ({
              type: "block.upserted" as const,
              block: contentForBlockInput({
                id: block.id,
                turnId: block.turnId as TurnId,
                responseId: block.responseId,
                blockType: block.blockType,
                sequence: block.sequence,
                content: block.content,
                status: "complete",
              }),
            })),
          );
        }
      }
      adoptedTurnsByMessageId.set(message.id, [existing, ...extraTurns]);
      adoptedBlocks.push(...blocks);
      continue;
    }
    fresh.push(message);
  }
  // Chain fresh messages (and the notices turn) from the durable leaf so a
  // pre-persisted writer turn (adopted above) is not forked past.
  const needsAppend =
    fresh.some(
      (message) => message.intent === "message" || message.body.kind === "work_context_refresh",
    ) ||
    input.notices.length > 0 ||
    fresh.some((message) => message.intent === "notice");
  const activeLeaf = needsAppend
    ? ((await input.persistence.repos.threads.findById(input.threadId))?.activeLeafTurnId ?? null)
    : input.expectedLeafTurnId;
  const activeLeafTurn = activeLeaf
    ? await input.persistence.repos.turns.findById(activeLeaf)
    : null;
  if (activeLeaf && !activeLeafTurn) throw new Error(`Missing causal turn: ${activeLeaf}`);
  const plan = planMessageTurns({
    threadId: input.threadId,
    batch: fresh,
    workContext: input.workContext,
    notices: input.notices,
    prevTurnId: activeLeaf,
    prevTurnPosition: activeLeafTurn?.position ?? null,
    knownTurnIds: new Set(),
  });
  const planEventsByTurnId = new Map<TurnId, OrchestratorEvent[]>();
  for (const event of plan.events) {
    const turnId =
      event.type === "turn.created"
        ? event.turn.id
        : event.type === "block.upserted"
          ? (event.block.turnId as TurnId)
          : event.type === "work_context.changed"
            ? (event.turnId as TurnId)
            : null;
    if (!turnId) continue;
    const events = planEventsByTurnId.get(turnId) ?? [];
    events.push(event);
    planEventsByTurnId.set(turnId, events);
  }
  const freshTurnsById = new Map(plan.turns.map((turn) => [turn.id, turn]));
  const orderedTurns: Turn[] = [];
  const events: OrchestratorEvent[] = [];
  for (const message of batch) {
    const adopted = adoptedTurnsByMessageId.get(message.id);
    if (adopted) {
      orderedTurns.push(...adopted);
      events.push(...(adoptedEventsByMessageId.get(message.id) ?? []));
      continue;
    }
    const freshTurn = freshTurnsById.get(message.id as TurnId);
    if (freshTurn) {
      orderedTurns.push(freshTurn);
      events.push(...(planEventsByTurnId.get(freshTurn.id) ?? []));
    }
  }
  const noticesTurn = plan.turns.find((turn) => turn.id === plan.noticesTurnId);
  if (noticesTurn) {
    orderedTurns.push(noticesTurn);
    events.push(...(planEventsByTurnId.get(noticesTurn.id) ?? []));
  }
  const plannedBlocks = plan.blocks.map(localBlockFromEvent);
  // Each fresh message maps to exactly the one turn built for it; notices have
  // no owning message and are appended after the batch.
  return {
    turns: orderedTurns,
    blocks: [...adoptedBlocks, ...plannedBlocks],
    events,
    ackIds: batch.map((message) => message.id),
  };
}

/**
 * The one planner for "an inbox batch (plus its notices) becomes durable
 * turns": filters `knownTurnIds`, chains each fresh `message` from the previous
 * turn, appends a trailing `system_update` turn for `notices` when present, and
 * emits the `turn.created` + `block.upserted` pairs that advance the leaf. Pure,
 * so run-start and mid-run preparation share one home for chain and idempotency
 * semantics before the delivery boundary opens its transaction.
 */
export function planMessageTurns(input: {
  threadId: ThreadId;
  batch: readonly InboxMessage[];
  workContext?: RenderedWorkContext;
  notices?: readonly Notice[];
  prevTurnId: TurnId | null;
  prevTurnPosition: number | null;
  knownTurnIds: ReadonlySet<TurnId>;
}): {
  turns: Turn[];
  blocks: BlockUpsertedRow[];
  events: OrchestratorEvent[];
  leafTurnId: TurnId | null;
  /** The trailing notices turn's id, when `notices` was non-empty. */
  noticesTurnId: TurnId | null;
} {
  const turns: Turn[] = [];
  const blocks: BlockUpsertedRow[] = [];
  const events: OrchestratorEvent[] = [];
  let leafTurnId = input.prevTurnId;
  let leafPosition = input.prevTurnPosition;
  for (const message of input.batch) {
    if (
      message.intent !== "message" &&
      !(message.body.kind === "work_context_refresh" && input.workContext)
    )
      continue;
    if (input.knownTurnIds.has(message.id)) continue;
    const { turn, block } = messageTurnFor(
      message,
      leafTurnId,
      nextTurnPosition(leafPosition === null ? null : { position: leafPosition }),
      input.workContext,
    );
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
    leafPosition = turn.position;
  }
  let noticesTurnId: TurnId | null = null;
  const notices = [
    ...(input.notices ?? []),
    ...input.batch
      .filter(
        (message) => message.intent === "notice" && message.body.kind !== "work_context_refresh",
      )
      .map(inboxMessageNotice),
  ];
  if (notices.length) {
    const { turn, block } = noticesTurnFor(
      input.threadId,
      notices,
      leafTurnId,
      nextTurnPosition(leafPosition === null ? null : { position: leafPosition }),
    );
    turns.push(turn);
    blocks.push(block);
    events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
    leafTurnId = turn.id;
    leafPosition = turn.position;
    noticesTurnId = turn.id;
  }
  return { turns, blocks, events, leafTurnId, noticesTurnId };
}

/**
 * Builds the durable user turn and text block for one drained `message`. The
 * inbox message id is reused as the turn/block id so a redelivery is idempotent;
 * the repository assigns its position when the drain is serialized.
 */
export function messageTurnFor(
  message: InboxMessage,
  prevTurnId: TurnId | null,
  position: number,
  workContext?: RenderedWorkContext,
): { turn: Turn; block: BlockUpsertedRow } {
  const isChildNotification = message.provenance.kind === "child";
  // Production writer sends are persisted and adopted by id at enqueue; keep
  // this fallback's writer metadata aligned if an inbox writer turn is ever
  // materialized without that normal path.
  const turn = createLocalTurn({
    id: message.id,
    threadId: message.threadId,
    position,
    prevTurnId,
    role: isChildNotification ? "system" : "user",
    // Writer provenance is the only human send; every other provenance
    // (agent/child/system) is a machine injection.
    origin: message.provenance.kind === "writer" ? "writer" : "system",
    status: "complete",
    metadata:
      message.provenance.kind === "child"
        ? childCompletionMetadata({
            handle: message.provenance.handle,
            outcome: message.provenance.outcome,
            execution: message.provenance.reportId,
            childThreadId: message.provenance.threadId,
            agentName: message.provenance.agentName,
          })
        : message.body.kind === "work_context_refresh"
          ? workUpdateMetadata()
          : message.provenance.kind === "writer"
            ? null
            : inboxMessageMetadata(),
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

/**
 * Builds the durable system turn and text block carrying every request-only
 * notice for one delivery boundary: peeked `NoticePort` notices (`undo`,
 * `awareness_degraded`, writer `work_switched`) and non-message inbox entries,
 * formatted exactly like the request-only rendering they replace. Persisting
 * this once makes the notice reproduce identically on every later request
 * instead of vanishing once the drain that carried it ends.
 */
export function noticesTurnFor(
  threadId: ThreadId,
  notices: readonly Notice[],
  prevTurnId: TurnId | null,
  position: number,
): { turn: Turn; block: BlockUpsertedRow } {
  const turn = createLocalTurn({
    threadId,
    position,
    prevTurnId,
    role: "system",
    // The platform injects this, never the writer.
    origin: "system",
    status: "complete",
    metadata: noticesMetadata(),
  });
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    textContent: `<system_update>\n${formatNotices(notices)}\n</system_update>`,
    sequence: 0,
    status: "complete",
  });
  return { turn, block };
}

export function inboxMessageText(message: InboxMessage): string {
  switch (message.body.kind) {
    case "handoff_brief":
      return "Write handoff brief";
    case "compaction_undo":
      return "Undo compaction";
    case "compact":
      return "Compact conversation";
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
