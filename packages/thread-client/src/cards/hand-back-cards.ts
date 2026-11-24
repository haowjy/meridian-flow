import { classifyCommandFailure } from "@meridian/contracts/failures";
import { occurrenceKey } from "../commands";
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
      if (running !== entry.request.seenExecutionId) continue;
      cards.push({
        key: occurrenceKey(entry),
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
      key: occurrenceKey(entry.occurrence),
      failure: classifyCommandFailure({
        kind: refused ? "refused" : entry.status === "unsaved" ? "unsaved" : "lost",
      }),
      copy:
        entry.commandKind === "stop" &&
        entry.targetExecutionId !== null &&
        running === entry.targetExecutionId
          ? "stop-failed"
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
