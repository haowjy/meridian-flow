/**
 * The cards a hand-back or Send now still owes the writer: which failures show, with which copy,
 * count and action. The app renders them in the composer's notice stack in order and decides
 * nothing; they depend on the commands, never on rows a hand-back may already have removed.
 */
import type { SendNowRequest } from "@meridian/contracts/threads";
import type { RunStateView } from "../run-state/run-state-view";
import type { UnresolvedHandBack } from "./operation";

/** A Send now that did not succeed. The host holds it; it is not a hand-back command. */
export type FailedSendNow = {
  kind: "send-now";
  status: "ambiguous" | "refused";
  /** The frozen body, re-sent unchanged by Try again. */
  request: SendNowRequest;
};

export type HandBackCardCopy =
  /** "Couldn't stop the reply." (a Stop failure while its reply still runs) */
  | "stop-failed"
  /** "Couldn't move your queued message to the message box." (plural with `count`) */
  | "hand-back-failed"
  /** "Couldn't move your queued message." */
  | "hand-back-refused"
  /** "Couldn't send now." */
  | "send-now-failed";

export type HandBackCard = {
  /** Stable key for rendering: the request id, or `send-now:<seenExecutionId>`. */
  key: string;
  copy: HandBackCardCopy;
  count: number;
  /** `retry` replays the held command; `dismiss` forgets a refused one. */
  action: "retry" | "dismiss";
  source: { kind: "hand-back"; requestId: string } | { kind: "send-now"; seenExecutionId: string };
};

export function handBackCards(
  unresolved: readonly (UnresolvedHandBack | FailedSendNow)[],
  view: RunStateView,
): HandBackCard[] {
  const running = view.record?.execution?.executionId ?? null;
  const cards: HandBackCard[] = [];
  for (const entry of unresolved) {
    if (entry.kind === "send-now") {
      // The card goes when the reply it targeted ends.
      if (running !== entry.request.seenExecutionId) continue;
      cards.push({
        key: `send-now:${entry.request.seenExecutionId}`,
        copy: "send-now-failed",
        count: entry.request.waiting.length,
        action: entry.status === "refused" ? "dismiss" : "retry",
        source: { kind: "send-now", seenExecutionId: entry.request.seenExecutionId },
      });
      continue;
    }
    const refused = entry.status === "refused";
    cards.push({
      key: entry.requestId,
      // While the reply runs, a Stop's failure reads as Stop's; once it ended, as the x's.
      copy:
        entry.commandKind === "stop" && running !== null
          ? "stop-failed"
          : refused
            ? "hand-back-refused"
            : "hand-back-failed",
      count: entry.count,
      action: refused ? "dismiss" : "retry",
      source: { kind: "hand-back", requestId: entry.requestId },
    });
  }
  return cards;
}
