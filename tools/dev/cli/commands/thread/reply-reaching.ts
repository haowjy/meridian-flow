/**
 * `./mf send`'s snapshot fallback: the assistant reached from a user turn
 * through only non-assistant turns (the live one, else the latest). A CLI-local
 * copy of the transcript-ancestry guess the server contract no longer carries;
 * #768 replaces it with the run-identity follow rule.
 */
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";

export function replyReaching(turns: readonly Turn[], turnId: string): Turn | undefined {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const reaches = (reply: Turn) => {
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
