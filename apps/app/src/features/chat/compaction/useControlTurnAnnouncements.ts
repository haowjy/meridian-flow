/**
 * useControlTurnAnnouncements — speaks the state changes of placeholder turns
 * with no reply stream: compaction dividers and handoff brief seeds (the
 * first, and each Retry's, including one that exists only on the client until
 * the server has it).
 *
 * Those rows are virtualized and may be off-screen, so the announcement is
 * driven from the turns, not from a mounted row. History present at mount is
 * seeded silently; only changes the writer can witness are announced. A failure
 * is not announced here: it is a card (`chatCards`), spoken once by the card announcer.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { isHandoffSeed } from "@meridian/contracts/threads";
import { useEffect, useRef } from "react";
import { announce } from "@/client/stores";

function announcementFor(turn: Turn): string | null {
  if (turn.role === "compaction") {
    switch (turn.status) {
      case "pending":
      case "streaming":
        return t`Compacting conversation`;
      case "complete":
        return t`Conversation compacted`;
      case "cancelled":
        return t`Compaction stopped`;
      default:
        return null;
    }
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
      default:
        return null;
    }
  }
  return null;
}

function isControlTurn(turn: Turn): boolean {
  return turn.role === "compaction" || isHandoffSeed(turn);
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
