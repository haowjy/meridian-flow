/** Load a thread's transcript, resolving fork prefixes through their owning thread rows. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import type { BlockRepository, ThreadRepository, TurnRepository } from "../ports/index.js";

export interface ThreadConversationContextDeps {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  turns: TurnRepository;
  blocks: BlockRepository;
}

export interface ThreadConversationContext {
  turns: Turn[];
  blocks: Block[];
}

export type ThreadConversationContextErrorCode =
  | "missing_cutoff_turn"
  | "missing_cutoff_owner"
  | "cutoff_not_in_transcript"
  | "fork_cycle";

/** A fork's inherited transcript cannot be reconstructed from its stored lineage. */
export class ThreadConversationContextError extends Error {
  constructor(
    readonly code: ThreadConversationContextErrorCode,
    readonly threadId: string,
    readonly originTurnId: string | null,
  ) {
    super(
      code === "missing_cutoff_turn"
        ? `Fork ${threadId} has no cutoff turn`
        : code === "missing_cutoff_owner"
          ? `Fork ${threadId} cutoff turn ${originTurnId} has no owning thread`
          : code === "cutoff_not_in_transcript"
            ? `Fork ${threadId} cutoff turn ${originTurnId} is absent from its owner's transcript`
            : `Fork history contains a cycle at thread ${threadId}`,
    );
    this.name = "ThreadConversationContextError";
  }
}

/** Load thread turns/blocks, hydrating a fork's inherited prefix from its cutoff owner. */
export async function loadThreadConversationContext(
  deps: ThreadConversationContextDeps,
  thread: Thread,
  visiting: ReadonlySet<ThreadId> = new Set(),
): Promise<ThreadConversationContext> {
  const threadId = thread.id as ThreadId;
  if (visiting.has(threadId)) {
    throw new ThreadConversationContextError("fork_cycle", thread.id, thread.originTurnId ?? null);
  }

  const nextVisiting = new Set(visiting);
  nextVisiting.add(threadId);
  const localTurns = await deps.turns.listByThread(threadId);
  const localBlocks = await deps.blocks.listByThread(threadId);

  if (thread.originType !== "fork") return { turns: localTurns, blocks: localBlocks };

  const originTurnId = thread.originTurnId;
  if (!originTurnId) {
    throw new ThreadConversationContextError("missing_cutoff_turn", thread.id, null);
  }

  const originTurn = await deps.turns.findById(originTurnId as TurnId);
  if (!originTurn) {
    throw new ThreadConversationContextError("missing_cutoff_turn", thread.id, originTurnId);
  }

  const sourceThread = await deps.threads.findByIdIncludingDeleted(originTurn.threadId as ThreadId);
  if (!sourceThread) {
    throw new ThreadConversationContextError("missing_cutoff_owner", thread.id, originTurnId);
  }

  const sourceContext = await loadThreadConversationContext(deps, sourceThread, nextVisiting);
  const originIndex = sourceContext.turns.findIndex((turn) => turn.id === originTurnId);
  if (originIndex < 0) {
    throw new ThreadConversationContextError("cutoff_not_in_transcript", thread.id, originTurnId);
  }

  const inheritedTurns = sourceContext.turns.slice(0, originIndex + 1);
  const inheritedTurnIds = new Set(inheritedTurns.map((turn) => turn.id));
  const inheritedBlocks = sourceContext.blocks.filter((block) =>
    inheritedTurnIds.has(block.turnId),
  );

  return {
    turns: [...inheritedTurns, ...localTurns],
    blocks: [...inheritedBlocks, ...localBlocks],
  };
}
