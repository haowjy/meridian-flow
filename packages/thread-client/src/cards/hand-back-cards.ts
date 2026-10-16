/**
 * The cards a hand-back or Send now still owes the writer, folded into `chatCards`: which failures
 * show, with which copy, count and action. They depend on the commands, never on rows a hand-back
 * may already have removed, so they sit in the composer's card stack.
 */
import { classifyCommandFailure } from "@meridian/contracts/failures";
import type { UnresolvedHandBack } from "../hand-back/operation";
import type { FailedSendNow } from "../hand-back/send-now";
import { failedStopIsMoot } from "../run-state/fold-messages";
import type { RunStateView } from "../run-state/run-state-view";
import type { ChatCard } from "./types";

export function handBackCards(
  unresolved: readonly (UnresolvedHandBack | FailedSendNow)[],
  view: RunStateView,
): ChatCard[] {
  const running = view.record?.execution?.executionId ?? null;
  const cards: ChatCard[] = [];
  for (const entry of unresolved) {
    if (entry.kind === "send-now") {
      // The card goes when the reply it targeted ends.
      if (running !== entry.request.seenExecutionId) continue;
      cards.push({
        key: `${entry.request.seenExecutionId}:${entry.attempt}`,
        failure: classifyCommandFailure({ kind: entry.status === "refused" ? "refused" : "lost" }),
        copy: "send-now-failed",
        action: entry.status === "refused" ? "dismiss" : "try_again",
        anchor: "composer",
        count: entry.request.waiting.length,
        text: null,
        requestId: null,
      });
      continue;
    }
    if (
      entry.commandKind === "stop" &&
      failedStopIsMoot(view, {
        targetExecutionId: entry.targetExecutionId,
        candidates: entry.count,
      })
    )
      continue;
    const refused = entry.status === "refused";
    cards.push({
      key: `${entry.requestId}:${entry.attempt}`,
      failure: classifyCommandFailure({
        kind: refused ? "refused" : entry.status === "unsaved" ? "unsaved" : "lost",
      }),
      // While the reply the Stop targeted still runs, its failure reads as Stop's; once that
      // reply ended (even if another runs), as the x's.
      copy:
        entry.commandKind === "stop" &&
        entry.targetExecutionId !== null &&
        running === entry.targetExecutionId
          ? "stop-failed"
          : refused
            ? "hand-back-refused"
            : "hand-back-failed",
      action: refused ? "dismiss" : "try_again",
      anchor: "composer",
      count: entry.count,
      text: null,
      requestId: entry.requestId,
    });
  }
  return cards;
}
