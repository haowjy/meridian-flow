/**
 * The turn graph: every turn of a chat, including the writer messages a hand-back took out of it.
 * Positions, `prevTurnId`, the leaf and fork cutoffs live here, so a graph consumer reads it and
 * filters what it shows. `TurnRepository` and `BlockRepository` themselves return the conversation.
 *
 * The graph hangs off the repository under a symbol that only this module exports, and Biome's
 * `noRestrictedImports` (biome.json) lets only the modules that own graph logic import this file.
 * A reader of content that never imports it cannot reach a handed-back turn.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import type { TurnRepository } from "./repositories.js";

export const TURN_GRAPH: unique symbol = Symbol("meridian.turnGraph");

export interface TurnGraph {
  /** Every turn of the thread in position order. */
  listByThread(threadId: ThreadId): Promise<Turn[]>;
  /** A turn by id, handed back or not. */
  findById(id: TurnId): Promise<Turn | null>;
  /** The last turn by position: the leaf positions are allocated from. */
  latest(threadId: ThreadId): Promise<Turn | null>;
}

export function turnGraph(turns: Pick<TurnRepository, typeof TURN_GRAPH>): TurnGraph {
  return turns[TURN_GRAPH];
}
