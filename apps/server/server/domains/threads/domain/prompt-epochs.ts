/** Resolve immutable prompt bakes through a thread's local epoch boundaries. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { PromptBake, Thread, Turn } from "@meridian/contracts/threads";
import type {
  PromptBakeRepository,
  ThreadRepository,
  TurnRepository,
} from "../ports/repositories.js";

export interface PromptEpochReader {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  turns: Pick<TurnRepository, "listByThread">;
  promptBakes: Pick<PromptBakeRepository, "findById">;
}

export class PromptBakeNotFoundError extends Error {
  constructor(readonly promptBakeId: string) {
    super(`Prompt bake not found: ${promptBakeId}`);
    this.name = "PromptBakeNotFoundError";
  }
}

export class PromptBakeTurnNotFoundError extends Error {
  constructor(
    readonly turnId: string,
    readonly threadId: string,
  ) {
    super(`Turn ${turnId} is not local to its owner thread ${threadId}`);
    this.name = "PromptBakeTurnNotFoundError";
  }
}

/** Returns the bake in effect through this local transcript turn. */
export function bakeIdAt(
  localTurns: readonly Turn[],
  turnId: string,
  initialBakeId: string | null,
): string | null {
  const turns = [...localTurns].sort((left, right) => left.position - right.position);
  const cutoffIndex = turns.findIndex((turn) => turn.id === turnId);
  if (cutoffIndex < 0) {
    throw new PromptBakeTurnNotFoundError(turnId, turns[0]?.threadId ?? "unknown");
  }

  const boundary = [...turns.slice(0, cutoffIndex + 1)]
    .reverse()
    .find((turn) => turn.status === "complete" && turn.promptBakeId != null);
  return boundary?.promptBakeId ?? initialBakeId;
}

/** Bake in effect at a local or inherited turn, using the cutoff turn's owner. */
export async function bakeAt(
  deps: PromptEpochReader,
  turn: Pick<Turn, "id" | "threadId">,
  knownLocalTurns?: readonly Turn[],
): Promise<PromptBake | null> {
  const owner = await deps.threads.findByIdIncludingDeleted(turn.threadId as ThreadId);
  if (!owner) throw new Error(`Prompt bake owner thread not found: ${turn.threadId}`);
  const localTurns = knownLocalTurns ?? (await deps.turns.listByThread(owner.id as ThreadId));
  const bakeId = bakeIdAt(localTurns, turn.id, owner.initialPromptBakeId ?? null);
  return bakeById(deps, bakeId);
}

/** Bake currently governing this thread's latest local turn, or its first bake. */
export async function bakeInEffect(
  deps: PromptEpochReader,
  thread: Pick<Thread, "id" | "initialPromptBakeId">,
  knownLocalTurns?: readonly Turn[],
): Promise<PromptBake | null> {
  const localTurns = knownLocalTurns ?? (await deps.turns.listByThread(thread.id as ThreadId));
  const latestLocalTurn = [...localTurns]
    .sort((left, right) => left.position - right.position)
    .at(-1);
  const bakeId = latestLocalTurn
    ? bakeIdAt(localTurns, latestLocalTurn.id, thread.initialPromptBakeId ?? null)
    : (thread.initialPromptBakeId ?? null);
  return bakeById(deps, bakeId);
}

async function bakeById(deps: PromptEpochReader, id: string | null): Promise<PromptBake | null> {
  return id ? requireBake(deps, id) : null;
}

async function requireBake(deps: PromptEpochReader, id: string): Promise<PromptBake> {
  const bake = await deps.promptBakes.findById(id);
  if (!bake) throw new PromptBakeNotFoundError(id);
  return bake;
}
