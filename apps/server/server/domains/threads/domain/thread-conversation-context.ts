/** Load a thread's transcript, resolving fork prefixes through their owning thread rows. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { orderTurnsByPosition } from "../order-turns.js";
import type { BlockRepository, ThreadRepository, TurnRepository } from "../ports/index.js";

export interface ThreadConversationContextDeps {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  turns: TurnRepository;
  blocks: BlockRepository;
}

/**
 * The conversation: every turn and block the model, a page, a fork, a summary or a snapshot may see.
 * A handed-back writer message (`turns.listHandedBackIds`) is not in it; its turn stays in the graph
 * (`turns.listByThread`), which positions, `prevTurnId`, the leaf and fork cutoffs still read.
 */
export interface ThreadConversationContext {
  turns: Turn[];
  blocks: Block[];
  /** The fork prefix this thread inherits, already in `turns` and `blocks`. Empty outside a fork. */
  inherited: { turns: Turn[]; blocks: Block[] };
  /** This thread's own turns and blocks, already in `turns` and `blocks`. */
  local: { turns: Turn[]; blocks: Block[] };
}

/** Graph turns and every block, before the hand-back filter. */
interface Part {
  turns: Turn[];
  blocks: Block[];
}
interface Loaded {
  inherited: Part;
  local: Part;
  /** User turns handed back anywhere in the lineage. */
  hidden: ReadonlySet<string>;
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
  throughTurnId?: TurnId,
): Promise<ThreadConversationContext> {
  const loaded = await loadGraph(deps, thread, throughTurnId, new Set());
  const keep = <T extends { id: string } | { turnId: string }>(items: T[]) =>
    items.filter((item) => !loaded.hidden.has("turnId" in item ? item.turnId : item.id));
  const inherited = { turns: keep(loaded.inherited.turns), blocks: keep(loaded.inherited.blocks) };
  const local = { turns: keep(loaded.local.turns), blocks: keep(loaded.local.blocks) };
  return {
    turns: orderTurnsByPosition([...inherited.turns, ...local.turns]),
    blocks: [...inherited.blocks, ...local.blocks],
    inherited,
    local,
  };
}

/** The thread's own conversation blocks: its blocks minus those of handed-back user turns. */
export async function listConversationBlocks(
  deps: Pick<ThreadConversationContextDeps, "turns" | "blocks">,
  threadId: ThreadId,
): Promise<Block[]> {
  const [hidden, blocks] = await Promise.all([
    deps.turns.listHandedBackIds(threadId),
    deps.blocks.listByThread(threadId),
  ]);
  return blocks.filter((block) => !hidden.has(block.turnId));
}

/** The thread's own conversation turns in position order: its graph minus handed-back user turns. */
export async function listConversationTurns(
  deps: Pick<ThreadConversationContextDeps, "turns">,
  threadId: ThreadId,
): Promise<Turn[]> {
  const [hidden, turns] = await Promise.all([
    deps.turns.listHandedBackIds(threadId),
    deps.turns.listByThread(threadId),
  ]);
  return orderTurnsByPosition(turns.filter((turn) => !hidden.has(turn.id)));
}

async function loadGraph(
  deps: ThreadConversationContextDeps,
  thread: Thread,
  throughTurnId: TurnId | undefined,
  visiting: ReadonlySet<ThreadId>,
): Promise<Loaded> {
  const threadId = thread.id as ThreadId;
  if (visiting.has(threadId)) {
    throw new ThreadConversationContextError("fork_cycle", thread.id, thread.originTurnId ?? null);
  }

  const nextVisiting = new Set(visiting);
  nextVisiting.add(threadId);
  const local: Part = {
    turns: orderTurnsByPosition(await deps.turns.listByThread(threadId)),
    blocks: await deps.blocks.listByThread(threadId),
  };
  const hidden = new Set(await deps.turns.listHandedBackIds(threadId));
  const none: Part = { turns: [], blocks: [] };

  if (thread.originType !== "fork")
    return throughCutoff({ inherited: none, local, hidden }, thread, throughTurnId);

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

  // The cutoff is a graph position: a fork cut at a turn handed back later still resolves.
  const source = throughCutoff(
    await loadGraph(deps, sourceThread, undefined, nextVisiting),
    thread,
    originTurnId,
  );
  for (const id of source.hidden) hidden.add(id);
  return throughCutoff(
    {
      inherited: {
        turns: [...source.inherited.turns, ...source.local.turns],
        blocks: [...source.inherited.blocks, ...source.local.blocks],
      },
      local,
      hidden,
    },
    thread,
    throughTurnId,
  );
}

function throughCutoff(loaded: Loaded, thread: Thread, throughTurnId?: TurnId): Loaded {
  if (!throughTurnId) return loaded;
  const ordered = orderTurnsByPosition([...loaded.inherited.turns, ...loaded.local.turns]);
  const index = ordered.findIndex((turn) => turn.id === throughTurnId);
  if (index < 0)
    throw new ThreadConversationContextError("cutoff_not_in_transcript", thread.id, throughTurnId);
  const ids = new Set(ordered.slice(0, index + 1).map((turn) => turn.id));
  const part = (value: Part): Part => ({
    turns: value.turns.filter((turn) => ids.has(turn.id)),
    blocks: value.blocks.filter((block) => ids.has(block.turnId)),
  });
  return { inherited: part(loaded.inherited), local: part(loaded.local), hidden: loaded.hidden };
}
