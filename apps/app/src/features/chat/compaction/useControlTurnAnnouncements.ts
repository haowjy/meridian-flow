/**
 * useControlTurnAnnouncements — speaks the state changes of turns a writer
 * control runs as: compaction dividers, their undo markers, and handoff brief
 * seeds.
 *
 * Those rows are virtualized and may be off-screen, so the announcement is
 * driven from the turns, not from a mounted row. History present at mount is
 * seeded silently; only changes the writer can witness are announced. An
 * autocompaction's failure stays silent (R3): the failed reply announces it.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import { announce } from "@/client/stores";
import { isHandoffSeed } from "../derivation/handoff-seed";
import { compactionFailureCopy } from "./CompactionDivider";
import { readCompactionFacts, undoMarkerTarget } from "./compaction-model";

function announcementFor(turn: Turn): string | null {
  if (turn.role === "compaction") {
    const facts = readCompactionFacts(turn);
    switch (turn.status) {
      case "pending":
      case "streaming":
        return t`Compacting conversation`;
      case "complete":
        return t`Conversation compacted`;
      case "cancelled":
        return t`Compaction stopped`;
      case "error":
        return facts.trigger === "manual"
          ? compactionFailureCopy(facts.failureReason, turn.error)
          : null;
      default:
        return null;
    }
  }
  if (undoMarkerTarget(turn)) {
    if (turn.status === "complete") return t`Compaction undone`;
    if (turn.status === "error") return turn.error ?? t`The compaction couldn't be undone.`;
  }
  if (isHandoffSeed(turn)) {
    switch (turn.status) {
      case "pending":
      case "streaming":
        return t`Writing the handoff brief`;
      case "complete":
        return t`Handoff brief ready`;
      case "cancelled":
        return t`Handoff brief stopped`;
      case "error":
        return turn.error ?? t`Handoff brief unavailable`;
      default:
        return null;
    }
  }
  return null;
}

function isControlTurn(turn: Turn): boolean {
  return turn.role === "compaction" || undoMarkerTarget(turn) !== null || isHandoffSeed(turn);
}

export function useControlTurnAnnouncements(turns: readonly Turn[]): void {
  const seen = useRef<{ statuses: Map<string, string>; tail: number } | null>(null);
  useEffect(() => {
    const previous = seen.current;
    const statuses = new Map<string, string>();
    let message: string | null = null;
    for (const turn of turns) {
      if (!isControlTurn(turn)) continue;
      statuses.set(turn.id, turn.status);
      const known = previous?.statuses.get(turn.id);
      // A known row that changed, or one appended after what the writer saw.
      const changed =
        previous !== null &&
        previous.tail >= 0 &&
        (known !== undefined ? known !== turn.status : turn.position > previous.tail);
      if (changed) message = announcementFor(turn) ?? message;
    }
    seen.current = { statuses, tail: turns.at(-1)?.position ?? -1 };
    if (message) announce(message);
  }, [turns]);
}
