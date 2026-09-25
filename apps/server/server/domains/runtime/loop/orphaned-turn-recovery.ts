/** Periodic crash recovery for assistant turns whose thread-run owner died. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadRepositories } from "../../threads/index.js";
import type { EventJournalWriter } from "../../threads/ports/event-journal.js";
import { finalizeError } from "./finalization.js";
import type { ThreadRunOwnership } from "./thread-run-ownership.js";

export interface OrphanTurnCandidate {
  id: TurnId;
  threadId: ThreadId;
}

export function createOrphanedTurnRecovery(deps: {
  listCandidates(limit: number): Promise<OrphanTurnCandidate[]>;
  repos: ThreadRepositories;
  eventWriter: EventJournalWriter;
  runOwnership: ThreadRunOwnership;
}) {
  return {
    async sweep(limit = 100): Promise<number> {
      const candidates = await deps.listCandidates(limit);
      let settled = 0;
      for (const candidate of candidates) {
        const claim = await deps.runOwnership.tryAcquire(candidate.threadId);
        if (!claim) continue;
        try {
          const turn = await deps.repos.turns.findById(candidate.id);
          if (
            !turn ||
            turn.threadId !== candidate.threadId ||
            turn.role !== "assistant" ||
            (turn.status !== "pending" && turn.status !== "streaming")
          ) {
            continue;
          }
          await finalizeError(
            { repos: deps.repos, eventWriter: deps.eventWriter },
            candidate.threadId,
            turn,
            "Turn ended unexpectedly before completion.",
          );
          settled += 1;
        } finally {
          await claim.release();
        }
      }
      return settled;
    },
  };
}
