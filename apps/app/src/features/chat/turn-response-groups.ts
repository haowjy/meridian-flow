/** Groups assistant turns that make up one writer-facing response. */
import type { Turn } from "@meridian/contracts/protocol";

/**
 * Maps each reply's final assistant turn id to all assistant parts in order.
 * Writer turns may sit inside a reply after a mid-run steer, but are never
 * included as response parts. The input is already filtered to visible turns.
 */
export function responsePartsByFinalTurnId(
  turns: readonly Turn[],
  awaitingSubagents: boolean,
): { partsByFinalTurnId: Map<string, readonly Turn[]>; continuing: boolean[] } {
  const groups = new Map<string, readonly Turn[]>();
  const continuing = Array.from({ length: turns.length }, () => false);
  let parts: Turn[] = [];

  const finish = () => {
    const finalPart = parts.at(-1);
    if (finalPart) groups.set(finalPart.id, parts);
    parts = [];
  };

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) continue;

    if (turn.role === "assistant") {
      if (parts.length === 0) parts = [turn];
      else parts.push(turn);
      continuing[index] = continuesResponse(turns, index, awaitingSubagents);
      if (!continuing[index]) finish();
      continue;
    }

    // A writer turn is inside the reply only when the preceding assistant part
    // said it was continuing (continuesResponse reads its enqueue-time steer fact).
    if (turn.role !== "user" || parts.length === 0) finish();
  }

  finish();
  return { partsByFinalTurnId: groups, continuing };
}

/**
 * Whether the reply keeps going past this assistant turn, so it is not a
 * finished turn and gets no settled action row. Only a turn the model ended
 * with nothing to pick it back up is finished. The next visible turn decides:
 * another assistant turn means a subagent notification woke the model; a
 * writer turn with the server-stamped steer delivery fact is a mid-run steer.
 * The latest turn also continues while background subagents are still running.
 */
export function continuesResponse(
  turns: readonly Turn[],
  index: number,
  awaitingSubagents: boolean,
): boolean {
  const turn = turns[index];
  if (turn?.role !== "assistant" || turn.status !== "complete") return false;
  const next = turns[index + 1];
  if (!next) return awaitingSubagents;
  if (next.role === "assistant") return true;
  if (next.role !== "user" || !next.metadata || typeof next.metadata !== "object") return false;
  return !Array.isArray(next.metadata) && next.metadata.delivery === "steer";
}
