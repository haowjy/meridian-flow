import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import type { TurnRepository } from "./repositories.js";

export const TURN_GRAPH: unique symbol = Symbol("meridian.turnGraph");

export interface TurnGraph {
  listByThread(threadId: ThreadId): Promise<Turn[]>;
  findById(id: TurnId): Promise<Turn | null>;
  latest(threadId: ThreadId): Promise<Turn | null>;
}

export function turnGraph(turns: Pick<TurnRepository, typeof TURN_GRAPH>): TurnGraph {
  return turns[TURN_GRAPH];
}
