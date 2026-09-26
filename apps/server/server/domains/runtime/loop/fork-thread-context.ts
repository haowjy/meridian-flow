/**
 * Fork thread context hydration: derived primary threads with `originType = fork`
 * inherit the source conversation through `originTurnId` without copying rows.
 *
 * The source is the thread that owns `originTurnId`, never `parentThreadId`: a
 * fork is a sibling of its source and shares the source's parent.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import type { BlockRepository, ThreadRepository, TurnRepository } from "../../threads/index.js";

export interface ForkThreadContextDeps {
  threads: Pick<ThreadRepository, "findById">;
  turns: TurnRepository;
  blocks: BlockRepository;
}

export interface ThreadConversationContext {
  turns: Turn[];
  blocks: Block[];
}

/** Load thread turns/blocks, hydrating a fork's inherited prefix from its source thread. */
export async function loadThreadConversationContext(
  deps: ForkThreadContextDeps,
  thread: Thread,
): Promise<ThreadConversationContext> {
  const localTurns = await deps.turns.listByThread(thread.id as ThreadId);
  const localBlocks = await deps.blocks.listByThread(thread.id as ThreadId);

  if (thread.originType !== "fork" || !thread.originTurnId) {
    return { turns: localTurns, blocks: localBlocks };
  }

  const originTurn = await deps.turns.findById(thread.originTurnId as TurnId);
  const sourceThread = originTurn
    ? await deps.threads.findById(originTurn.threadId as ThreadId)
    : null;
  if (!sourceThread) {
    return { turns: localTurns, blocks: localBlocks };
  }

  const sourceContext = await loadThreadConversationContext(deps, sourceThread);
  const sourceTurns = sourceContext.turns;
  const originIndex = sourceTurns.findIndex((turn) => turn.id === thread.originTurnId);
  if (originIndex < 0) {
    return { turns: localTurns, blocks: localBlocks };
  }

  const inheritedTurns = sourceTurns.slice(0, originIndex + 1);
  const inheritedTurnIds = new Set(inheritedTurns.map((turn) => turn.id));
  const inheritedBlocks = sourceContext.blocks.filter((block) =>
    inheritedTurnIds.has(block.turnId),
  );

  return {
    turns: [...inheritedTurns, ...localTurns],
    blocks: [...inheritedBlocks, ...localBlocks],
  };
}
