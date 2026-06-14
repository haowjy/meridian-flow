// @ts-nocheck
/**
 * Fork thread context hydration: derived primary threads with `originType = fork`
 * inherit the parent conversation through `originTurnId` without copying rows.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
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

/** Load thread turns/blocks, hydrating fork lineage from the parent through originTurnId. */
export async function loadThreadConversationContext(
  deps: ForkThreadContextDeps,
  thread: Thread,
): Promise<ThreadConversationContext> {
  const localTurns = await deps.turns.listByThread(thread.id as ThreadId);
  const localBlocks = await deps.blocks.listByThread(thread.id as ThreadId);

  if (thread.originType !== "fork" || !thread.parentThreadId || !thread.originTurnId) {
    return { turns: localTurns, blocks: localBlocks };
  }

  const parentThread = await deps.threads.findById(thread.parentThreadId as ThreadId);
  if (!parentThread) {
    return { turns: localTurns, blocks: localBlocks };
  }

  const parentContext = await loadThreadConversationContext(deps, parentThread);
  const parentTurns = parentContext.turns;
  const originIndex = parentTurns.findIndex((turn) => turn.id === thread.originTurnId);
  if (originIndex < 0) {
    return { turns: localTurns, blocks: localBlocks };
  }

  const inheritedTurns = parentTurns.slice(0, originIndex + 1);
  const inheritedTurnIds = new Set(inheritedTurns.map((turn) => turn.id));
  const inheritedBlocks = parentContext.blocks.filter((block) =>
    inheritedTurnIds.has(block.turnId),
  );

  return {
    turns: [...inheritedTurns, ...localTurns],
    blocks: [...inheritedBlocks, ...localBlocks],
  };
}
