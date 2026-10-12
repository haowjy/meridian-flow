/**
 * Transcript-ancestry guess at "which reply answers which turn": the turn graph
 * walked through non-assistant turns only. Superseded by run identity
 * (`Turn.executionId`, `Turn.delivery`); kept only for the app controller until
 * its follow rule replaces it. The server never reads it.
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
