/**
 * The inbox drain seam: materializes a claimed batch as durable history. A text
 * `message` becomes a persisted turn. Child-provenance messages become
 * structured subagent-update system turns; Work refreshes and every other
 * request-only notice (`NoticePort.drainForModelContext` plus non-message inbox
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
 * persists its missing text-reference reads (and any activated skill bodies).
 * The shared context assembler owns all rendering, including image projection
 * across the complete request's occurrence budget.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, BlockUpsertedRow, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { Notice } from "../../notices/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { formatNotices } from "./context-builder.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { InboxMessage } from "./ports.js";
import type { RenderedWorkContext } from "./work-context.js";

/** The rich blocks (and any hidden sibling turns) an adopted turn's preparation resolved. */
export interface AdoptedTurnPreparation {
  blocks: Block[];
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
   * Already-drained `NoticePort` notices for this thread. Draining is
   * destructive, so the caller (`adopt()`) owns calling it exactly once and
   * folding the result into the same split/persist decision as the batch.
   */
  notices: readonly Notice[];
  threadId: ThreadId;
  knownTurnIds: ReadonlySet<TurnId>;
  expectedLeafTurnId: TurnId | null;
  /**
   * Resolves an adopted turn's rich model-facing blocks before it renders (for
   * example, reads text-reference occurrences that lack a persisted result, or
   * persists a mid-run steer's activated skill bodies), returning the updated
   * blocks. A writer send persisted at enqueue has no run yet to resolve these
   * at first iteration, so adoption is where they land.
   */
  prepareAdoptedTurn?: (turn: Turn, blocks: Block[]) => Promise<AdoptedTurnPreparation>;
}): Promise<InboxDrain> {
  const batch = input.batch;
  const fresh: InboxMessage[] = [];
  // Keyed by message id, in final render order per message: the adopted turn
  // itself plus any hidden sibling turns its preparation persisted.
  const adoptedTurnsByMessageId = new Map<string, Turn[]>();
  const adoptedBlocks: Block[] = [];
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
        for (const extra of prepared.extraTurns ?? []) {
          extraTurns.push(extra.turn);
          adoptedBlocks.push(...extra.blocks);
        }
      }
      adoptedTurnsByMessageId.set(message.id, [existing, ...extraTurns]);
      adoptedBlocks.push(...blocks);
      continue;
    }
    fresh.push(message);
  }
  // Every non-message, non-work-refresh batch entry is itself a request-only
  // notice (an `inbox_notice`); fold it in with whatever `NoticePort` drained so
  // both become the same durable turn.
  const notices: Notice[] = [
    ...input.notices,
    ...batch
      .filter(
        (message) => message.intent !== "message" && message.body.kind !== "work_context_refresh",
      )
      .map(inboxMessageNotice),
  ];
  // Chain fresh messages (and the notices turn) from the durable leaf so a
  // pre-persisted writer turn (adopted above) is not forked past.
  const persistLeafTurnId =
    fresh.some(
      (message) => message.intent === "message" || message.body.kind === "work_context_refresh",
    ) || notices.length > 0
      ? ((await input.persistence.repos.threads.findById(input.threadId))?.activeLeafTurnId ??
        input.expectedLeafTurnId)
      : input.expectedLeafTurnId;
  const persisted = await persistInboxMessages({
    deps: input.persistence,
    threadId: input.threadId,
    expectedLeafTurnId: persistLeafTurnId,
    batch: fresh,
    workContext: input.workContext,
    notices,
  });
  // Each fresh message maps to exactly the one turn `planMessageTurns` built for
  // it (the trailing notices turn has no owning message and is appended below).
  const turnsByMessageId = new Map<string, Turn[]>(adoptedTurnsByMessageId);
  for (const turn of persisted.turns) {
    if (turn.id === persisted.noticesTurnId) continue;
    turnsByMessageId.set(turn.id, [turn]);
  }
  const orderedTurns = batch.flatMap((message) => turnsByMessageId.get(message.id) ?? []);
  const noticesTurn = persisted.turns.find((turn) => turn.id === persisted.noticesTurnId);
  return {
    turns: noticesTurn ? [...orderedTurns, noticesTurn] : orderedTurns,
    blocks: [...adoptedBlocks, ...persisted.blocks],
    ackIds: batch.map((message) => message.id),
  };
}

/**
 * The one planner for "an inbox batch (plus its notices) becomes durable
 * turns": filters `knownTurnIds`, chains each fresh `message` from the previous
 * turn, appends a trailing `system_update` turn for `notices` when present, and
 * emits the `turn.created` + `block.upserted` pairs that advance the leaf. Pure,
 * so both the drain start (`runDrainTurn`) and the mid-run drain
 * (`persistInboxMessages`) share one home for chain and idempotency semantics.
 */
export function planMessageTurns(input: {
  threadId: ThreadId;
  batch: readonly InboxMessage[];
  workContext?: RenderedWorkContext;
  notices?: readonly Notice[];
  prevTurnId: TurnId | null;
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
  let noticesTurnId: TurnId | null = null;
  if (input.notices?.length) {
    const { turn, block } = noticesTurnFor(input.threadId, input.notices, leafTurnId);
    turns.push(turn);
    blocks.push(block);
    events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
    leafTurnId = turn.id;
    noticesTurnId = turn.id;
  }
  return { turns, blocks, events, leafTurnId, noticesTurnId };
}

/**
 * Persists each directed `message` in a claimed batch as a user-role turn at the
 * thread tail, plus a trailing `system_update` turn for `notices` when present.
 * Returns the appended turns/blocks for the loop's in-memory accumulator.
 */
export async function persistInboxMessages(input: {
  deps: PersistenceDeps;
  threadId: ThreadId;
  /** The turn the first `message` follows; each later one follows the previous. */
  expectedLeafTurnId: TurnId | null;
  batch: readonly InboxMessage[];
  workContext?: RenderedWorkContext;
  notices?: readonly Notice[];
}): Promise<{ turns: Turn[]; blocks: Block[]; noticesTurnId: TurnId | null }> {
  const hasMessageContent = input.batch.some(
    (message) => message.intent === "message" || message.body.kind === "work_context_refresh",
  );
  if (!hasMessageContent && !input.notices?.length) {
    return { turns: [], blocks: [], noticesTurnId: null };
  }
  // One transition for the whole batch: a mid-batch failure cannot leave a
  // half-persisted batch, and the chain links each message (and the notices
  // turn) to the previous within the same transaction.
  const persisted = await persistAndAppendTurnStartEvents(
    input.deps,
    input.threadId,
    input.expectedLeafTurnId,
    async () => {
      const plan = planMessageTurns({
        threadId: input.threadId,
        batch: input.batch,
        workContext: input.workContext,
        notices: input.notices,
        prevTurnId: input.expectedLeafTurnId,
        knownTurnIds: new Set(),
      });
      return {
        result: {
          turns: plan.turns,
          blocks: plan.blocks.map(localBlockFromEvent),
          noticesTurnId: plan.noticesTurnId,
        },
        events: plan.events,
      };
    },
  );
  return persisted.result;
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
    // Writer provenance is the only human send; every other provenance
    // (agent/child/system) is a machine injection.
    origin: message.provenance.kind === "writer" ? "writer" : "system",
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

/**
 * Builds the durable system turn and text block carrying every request-only
 * notice for one drain: `NoticePort`-drained notices (`undo`,
 * `awareness_degraded`, writer `work_switched`) and non-message inbox entries,
 * formatted exactly like the request-only rendering they replace. Persisting
 * this once makes the notice reproduce identically on every later request
 * instead of vanishing once the drain that carried it ends.
 */
function noticesTurnFor(
  threadId: ThreadId,
  notices: readonly Notice[],
  prevTurnId: TurnId | null,
): { turn: Turn; block: BlockUpsertedRow } {
  const turn = createLocalTurn({
    threadId,
    prevTurnId,
    role: "system",
    // The platform injects this, never the writer.
    origin: "system",
    status: "complete",
    metadata: { kind: "system_update", section: "notices" },
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
