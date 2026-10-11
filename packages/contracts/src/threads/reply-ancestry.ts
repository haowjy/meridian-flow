/**
 * The durable form of "which reply answers which turn". A reply's request
 * carries the turns between it and the previous reply, so the relation is the
 * turn graph walked through non-assistant turns only (switch, compaction,
 * skill-body and notice turns sit between a message and its reply).
 *
 * The same walk reads a user turn's answering reply and a split reply's
 * same-lease successor; its inverse names the user turns a failed reply
 * answered, which its Retry re-answers.
 */
import { isTerminalTurnStatus, type TurnStatus } from "./status.js";

export type AncestryTurn = {
  id: string;
  role: string;
  prevTurnId?: string | null;
  status: TurnStatus;
};

/** The assistant reached from `turnId` through only non-assistant turns: the live one, else the latest. */
export function replyReaching<T extends AncestryTurn>(
  turns: readonly T[],
  turnId: string,
): T | undefined {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const reaches = (reply: T) => {
    let prev = reply.prevTurnId;
    while (prev) {
      if (prev === turnId) return true;
      const turn = byId.get(prev);
      if (!turn || turn.role === "assistant") return false;
      prev = turn.prevTurnId;
    }
    return false;
  };
  const replies = turns.filter((turn) => turn.role === "assistant" && reaches(turn));
  return replies.find((turn) => !isTerminalTurnStatus(turn.status)) ?? replies.at(-1);
}

/** The user turns a reply answers: those reached from it through only non-assistant turns, oldest first. */
export function userTurnsAnsweredBy<T extends AncestryTurn>(
  reply: T,
  byId: ReadonlyMap<string, T>,
): string[] {
  const answered: string[] = [];
  let prev = reply.prevTurnId;
  while (prev) {
    const turn = byId.get(prev);
    if (!turn || turn.role === "assistant") break;
    if (turn.role === "user") answered.unshift(turn.id);
    prev = turn.prevTurnId;
  }
  return answered;
}
