/** One indexed interpretation of visibility, response boundaries, delivery rows, and reveal targets. */
import { parseInvocationCard } from "@meridian/contracts/components";
import type { Turn } from "@meridian/contracts/protocol";
import { reportPersistedContractFailure } from "./persisted-contract-debug";
import { readSubagentUpdateMetadata } from "./subagent/update";

export type TurnClass = "bubble" | "delivery" | "context" | "plumbing";
const emptyEvents: DeliveryEvent[] = [];
export type DeliveryEvent = {
  turn: Turn;
  childThreadId?: string;
  agentName?: string;
  title?: string;
  subagentUpdate: ReturnType<typeof readSubagentUpdateMetadata>;
};

export function classifyTurn(turn: Turn): TurnClass {
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? turn.metadata
      : null;
  if (turn.role === "compaction") return "plumbing";
  if (turn.role === "assistant") return "bubble";
  if (metadata?.kind === "inbox_message" || metadata?.kind === "subagent_update") return "delivery";
  if (
    turn.role === "user" &&
    metadata?.kind === "system_update" &&
    metadata.section === "work_context"
  )
    return "context";
  if (turn.role === "user") return "bubble";
  return turn.blocks.some((block) => block.blockType === "custom") ? "bubble" : "plumbing";
}

export function buildTranscriptModel(turns: Turn[], awaitingSubagents: boolean) {
  const visibleTurns = turns.filter((turn) => classifyTurn(turn) === "bubble");
  const nextByPrev = new Map<string, Turn>();
  for (const turn of turns) if (turn.prevTurnId) nextByPrev.set(turn.prevTurnId, turn);
  const subagentUpdateByTurnId = new Map<string, ReturnType<typeof readSubagentUpdateMetadata>>();
  const invocationByExecution = new Map<
    string,
    { threadId?: string; agentName: string; title?: string }
  >();
  for (const turn of turns) {
    const metadata =
      turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
        ? (turn.metadata as Record<string, unknown>)
        : null;
    if (metadata?.kind === "subagent_update") {
      const update = readSubagentUpdateMetadata(metadata);
      subagentUpdateByTurnId.set(turn.id, update);
      if (!update) {
        reportPersistedContractFailure({
          contract: "subagent_update",
          turnId: turn.id,
        });
      }
    }
    for (const block of turn.blocks ?? []) {
      const content =
        block.content && typeof block.content === "object" && !Array.isArray(block.content)
          ? (block.content as Record<string, unknown>)
          : null;
      if (content?.kind !== "helper-result") continue;
      const card = parseInvocationCard(block.content);
      if (!card) {
        reportPersistedContractFailure({
          contract: "invocation_card",
          turnId: turn.id,
          blockId: block.id,
        });
      } else if (card.execution) {
        invocationByExecution.set(card.execution, {
          ...(card.childThreadId ? { threadId: card.childThreadId } : {}),
          agentName: card.agentName,
          ...(card.title ? { title: card.title } : {}),
        });
      }
    }
  }

  const deliveryEventsByAssistantTurnId = new Map<string, DeliveryEvent[]>();
  const latestRevealTurnByChildThreadId = new Map<string, string>();
  for (const turn of visibleTurns) {
    if (turn.role !== "assistant") continue;
    const events: DeliveryEvent[] = [];
    let cursor = turn.id;
    const seen = new Set<string>();
    while (true) {
      const next = nextByPrev.get(cursor);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      const kind = classifyTurn(next);
      if (kind === "delivery" && next.role === "system") {
        const update = subagentUpdateByTurnId.get(next.id) ?? null;
        const invocation = update?.execution
          ? invocationByExecution.get(update.execution)
          : undefined;
        const childThreadId = update?.childThreadId ?? invocation?.threadId;
        events.push({
          turn: next,
          subagentUpdate: update,
          ...(childThreadId ? { childThreadId } : {}),
          ...(update?.agentName || invocation?.agentName
            ? { agentName: update?.agentName ?? invocation?.agentName }
            : {}),
          ...(invocation?.title ? { title: invocation.title } : {}),
        });
        if (childThreadId) latestRevealTurnByChildThreadId.set(childThreadId, turn.id);
      } else if (kind === "bubble") break;
      cursor = next.id;
    }
    if (events.length) deliveryEventsByAssistantTurnId.set(turn.id, events);
  }

  const { partsByFinalTurnId, continuing } = responseGroups(visibleTurns, awaitingSubagents);
  return {
    visibleTurns,
    deliveryEventsByAssistantTurnId,
    invocationByExecution,
    latestRevealTurnByChildThreadId,
    continuing,
    partsByFinalTurnId,
    deliveryEventsFor: (turnId: string) =>
      deliveryEventsByAssistantTurnId.get(turnId) ?? emptyEvents,
    resolveRevealTurnId: (childThreadId: string, originTurnId: string) =>
      latestRevealTurnByChildThreadId.get(childThreadId) ?? originTurnId,
  };
}

function responseGroups(turns: readonly Turn[], awaitingSubagents: boolean) {
  const groups = new Map<string, readonly Turn[]>();
  const continuing = Array.from({ length: turns.length }, () => false);
  let parts: Turn[] = [];
  const finish = () => {
    const end = parts.at(-1);
    if (end) groups.set(end.id, parts);
    parts = [];
  };
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (!turn) continue;
    if (turn.role === "assistant") {
      parts.push(turn);
      continuing[index] = continuesResponse(turns, index, awaitingSubagents);
      if (!continuing[index]) finish();
    } else if (turn.role !== "user" || !parts.length) finish();
  }
  finish();
  return { partsByFinalTurnId: groups, continuing };
}

export function continuesResponse(
  turns: readonly Turn[],
  index: number,
  awaitingSubagents: boolean,
) {
  const turn = turns[index];
  if (turn?.role !== "assistant" || turn.status !== "complete") return false;
  const next = turns[index + 1];
  if (!next) return awaitingSubagents;
  if (next.role === "assistant") return true;
  return (
    next.role === "user" &&
    Boolean(
      next.metadata &&
        typeof next.metadata === "object" &&
        !Array.isArray(next.metadata) &&
        next.metadata.delivery === "steer",
    )
  );
}
