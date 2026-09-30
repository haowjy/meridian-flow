/** Resolves the owner thread of a fork's cutoff turn. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread, Turn } from "@meridian/contracts/threads";

export class ForkCutoffOwnerNotFoundError extends Error {
  constructor(
    readonly forkThreadId: string,
    readonly cutoffTurnId: string | null,
  ) {
    super(`Fork cutoff owner not found for thread ${forkThreadId}`);
    this.name = "ForkCutoffOwnerNotFoundError";
  }
}

export async function findCutoffOwnerThreadId(
  thread: Pick<Thread, "id" | "originType" | "originTurnId">,
  findTurnById: (turnId: string) => Promise<Pick<Turn, "id" | "threadId"> | null>,
): Promise<ThreadId> {
  if (thread.originType !== "fork") return thread.id as ThreadId;

  const cutoffTurn = thread.originTurnId ? await findTurnById(thread.originTurnId) : null;
  if (!cutoffTurn || cutoffTurn.id !== thread.originTurnId) {
    throw new ForkCutoffOwnerNotFoundError(thread.id, thread.originTurnId ?? null);
  }
  return cutoffTurn.threadId as ThreadId;
}
