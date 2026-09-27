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

/** Bake in effect at a local or inherited turn, using the cutoff turn's owner. */
export async function bakeAt(
  deps: PromptEpochReader,
  turn: Pick<Turn, "id" | "threadId">,
): Promise<PromptBake | null> {
  const owner = await deps.threads.findByIdIncludingDeleted(turn.threadId as ThreadId);
  if (!owner) throw new Error(`Prompt bake owner thread not found: ${turn.threadId}`);
  const localTurns = await deps.turns.listByThread(owner.id as ThreadId);
  const cutoffIndex = localTurns.findIndex((candidate) => candidate.id === turn.id);
  if (cutoffIndex < 0) throw new PromptBakeTurnNotFoundError(turn.id, owner.id);

  const boundary = [...localTurns.slice(0, cutoffIndex + 1)]
    .reverse()
    .find((candidate) => candidate.status === "complete" && candidate.promptBakeId != null);
  if (boundary?.promptBakeId) return requireBake(deps, boundary.promptBakeId);
  return bakeById(deps, owner.initialPromptBakeId ?? null);
}

/** Bake currently governing this thread's latest local turn, or its first bake. */
export async function bakeInEffect(
  deps: PromptEpochReader,
  thread: Pick<Thread, "id" | "initialPromptBakeId">,
): Promise<PromptBake | null> {
  const localTurns = await deps.turns.listByThread(thread.id as ThreadId);
  const latestLocalTurn = localTurns.at(-1);
  return latestLocalTurn
    ? bakeAt(deps, latestLocalTurn)
    : bakeById(deps, thread.initialPromptBakeId ?? null);
}

async function bakeById(deps: PromptEpochReader, id: string | null): Promise<PromptBake | null> {
  return id ? requireBake(deps, id) : null;
}

async function requireBake(deps: PromptEpochReader, id: string): Promise<PromptBake> {
  const bake = await deps.promptBakes.findById(id);
  if (!bake) throw new PromptBakeNotFoundError(id);
  return bake;
}
