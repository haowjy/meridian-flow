/** Periodic crash recovery for assistant turns whose thread-run owner died. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ThreadRepositories } from "../../threads/index.js";
import type { EventJournalReader, EventJournalWriter } from "../../threads/ports/event-journal.js";
import { finalizeError } from "./finalization.js";
import type { InterruptRegistry } from "./interrupts.js";
import type { ThreadRunOwnership } from "./thread-run-ownership.js";

export interface OrphanTurnCandidate {
  id: TurnId;
  threadId: ThreadId;
}

export function createOrphanedTurnRecovery(deps: {
  listCandidates(limit: number): Promise<OrphanTurnCandidate[]>;
  repos: ThreadRepositories;
  journalReader: EventJournalReader;
  eventWriter: EventJournalWriter;
  interruptRegistry: Pick<InterruptRegistry, "recoverPendingInterrupts">;
  eventSink: EventSink;
  runOwnership: ThreadRunOwnership;
}) {
  return {
    async sweep(limit = 100): Promise<number> {
      const candidates = await deps.listCandidates(limit);
      let settled = 0;
      for (const candidate of candidates) {
        let claim: Awaited<ReturnType<ThreadRunOwnership["tryAcquire"]>> = null;
        try {
          claim = await deps.runOwnership.tryAcquire(candidate.threadId);
          if (!claim) continue;
          const turn = await deps.repos.turns.findById(candidate.id);
          if (
            !turn ||
            turn.threadId !== candidate.threadId ||
            turn.role !== "assistant" ||
            (turn.status !== "pending" &&
              turn.status !== "streaming" &&
              turn.status !== "waiting_interrupt")
          ) {
            continue;
          }
          if (turn.status === "waiting_interrupt") {
            const events = await deps.interruptRegistry.recoverPendingInterrupts({
              repos: deps.repos,
              journalReader: deps.journalReader,
              journalWriter: deps.eventWriter,
              threadId: candidate.threadId,
              hasLivePendingInterrupt: () => false,
            });
            if (events.some((event) => event.type === "turn.error" && event.turn.id === turn.id)) {
              settled += 1;
            } else {
              emitEvent(deps.eventSink, {
                level: "error",
                source: "runtime.orphaned-turn-recovery",
                name: "interrupt.recovery_unsettled",
                correlation: { threadId: candidate.threadId, turnId: candidate.id },
                payload: { threadId: candidate.threadId, turnId: candidate.id },
              });
            }
            continue;
          }
          await finalizeError(
            { repos: deps.repos, eventWriter: deps.eventWriter },
            candidate.threadId,
            turn,
            "Turn ended unexpectedly before completion.",
          );
          settled += 1;
        } catch (error) {
          emitEvent(deps.eventSink, {
            level: "error",
            source: "runtime.orphaned-turn-recovery",
            name: "candidate.failed",
            correlation: { threadId: candidate.threadId, turnId: candidate.id },
            payload: {
              threadId: candidate.threadId,
              turnId: candidate.id,
              ...unknownToEventPayload(error),
            },
          });
        } finally {
          try {
            await claim?.release();
          } catch (error) {
            emitEvent(deps.eventSink, {
              level: "error",
              source: "runtime.orphaned-turn-recovery",
              name: "claim.release_failed",
              correlation: { threadId: candidate.threadId, turnId: candidate.id },
              payload: {
                threadId: candidate.threadId,
                turnId: candidate.id,
                ...unknownToEventPayload(error),
              },
            });
          }
        }
      }
      return settled;
    },
  };
}
