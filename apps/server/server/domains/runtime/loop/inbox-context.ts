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
import { turnGraph } from "../../threads/ports/turn-graph.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { formatNotices } from "./context-builder.js";
import { createLocalTurn } from "./local-turn.js";
import type { PersistenceDeps } from "./persistence.js";
import type { InboxMessage } from "./ports.js";
import {
  hasReferenceEvidence,
  mergeReferenceEvidence,
  NO_REFERENCE_EVIDENCE,
  type ReferenceEvidence,
} from "./reference-context.js";
import type { RenderedWorkContext } from "./work-context.js";

export interface AdoptedTurnPreparation {
  blocks: Block[];
  events?: OrchestratorEvent[];
  extraTurns?: readonly { turn: Turn; blocks: readonly Block[] }[];
  evidence?: ReferenceEvidence;
}

export interface InboxDrain {
  turns: Turn[];
  blocks: Block[];
  events: OrchestratorEvent[];
  ackIds: string[];
  evidence?: ReferenceEvidence;
}

export async function drainInbox(input: {
  persistence: PersistenceDeps;
  batch: InboxMessage[];
  workContext?: RenderedWorkContext;
  notices: readonly Notice[];
  threadId: ThreadId;
  knownTurnIds: ReadonlySet<TurnId>;
  expectedLeafTurnId: TurnId | null;
  prepareAdoptedTurn?: (turn: Turn, blocks: Block[]) => Promise<AdoptedTurnPreparation>;
}): Promise<InboxDrain> {
  const batch = input.batch;
  const fresh: InboxMessage[] = [];
  const adoptedTurnsByMessageId = new Map<string, Turn[]>();
  const adoptedBlocks: Block[] = [];
  const adoptedEventsByMessageId = new Map<string, OrchestratorEvent[]>();
  let evidence: ReferenceEvidence = NO_REFERENCE_EVIDENCE;
  for (const message of batch) {
    if (message.intent !== "message" && message.body.kind !== "work_context_refresh") {
      fresh.push(message);
      continue;
    }
    if (input.knownTurnIds.has(message.id)) continue;
    const existing = await turnGraph(input.persistence.repos.turns).findById(message.id as TurnId);
    if (existing) {
      let blocks = await input.persistence.repos.blocks.listByTurn(existing.id);
      const extraTurns: Turn[] = [];
      if (input.prepareAdoptedTurn) {
        const prepared = await input.prepareAdoptedTurn(existing, blocks);
        blocks = prepared.blocks;
        adoptedEventsByMessageId.set(message.id, [...(prepared.events ?? [])]);
        evidence = mergeReferenceEvidence(evidence, prepared.evidence);
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
    ? await turnGraph(input.persistence.repos.turns).findById(activeLeaf)
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
  return {
    turns: orderedTurns,
    blocks: [...adoptedBlocks, ...plannedBlocks],
    events,
    ackIds: batch.map((message) => message.id),
    ...(hasReferenceEvidence(evidence) ? { evidence } : {}),
  };
}

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
        scope: { workId: scope.workId, workHandle: scope.workHandle },
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
  const noticeText = formatNotices(notices).trim();
  if (noticeText) {
    const { turn, block } = noticesTurnFor(
      input.threadId,
      noticeText,
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

export function messageTurnFor(
  message: InboxMessage,
  prevTurnId: TurnId | null,
  position: number,
  workContext?: RenderedWorkContext,
): { turn: Turn; block: BlockUpsertedRow } {
  const isChildNotification = message.provenance.kind === "child";
  const turn = createLocalTurn({
    id: message.id,
    threadId: message.threadId,
    position,
    prevTurnId,
    role: isChildNotification ? "system" : "user",
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
            : inboxMessageMetadata(
                message.provenance.kind === "agent" && message.provenance.sender
                  ? {
                      sender: {
                        threadId: message.provenance.threadId,
                        ...message.provenance.sender,
                      },
                    }
                  : {},
              ),
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

function noticesTurnFor(
  threadId: ThreadId,
  text: string,
  prevTurnId: TurnId | null,
  position: number,
): { turn: Turn; block: BlockUpsertedRow } {
  const turn = createLocalTurn({
    threadId,
    position,
    prevTurnId,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: noticesMetadata(),
  });
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    textContent: `<system_update>\n${text}\n</system_update>`,
    sequence: 0,
    status: "complete",
  });
  return { turn, block };
}

export function inboxMessageText(message: InboxMessage): string {
  switch (message.body.kind) {
    case "compact":
      return message.body.instructions
        ? `/compact ${message.body.instructions}`
        : "Compact conversation";
    case "write_mode":
      return message.body.mode === "direct"
        ? "Switch this chat to auto-apply"
        : "Switch this chat to draft mode";
    case "work_context_refresh":
      return "";
    case "text":
      return message.body.text;
    case "context":
      return message.body.parts.map((part) => part.text).join("\n\n");
    case "ask_resolved":
      return "";
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
