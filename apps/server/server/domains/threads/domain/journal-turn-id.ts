// @ts-nocheck
/**
 * Journal turn-id derivation: centralizes how persisted orchestrator events
 * expose their owning turn to JournalEntry metadata. Adapters must use this
 * helper instead of reimplementing shape-specific payload inspection.
 */
import type { OrchestratorEvent } from "@meridian/contracts/threads";

export function deriveJournalTurnId(event: OrchestratorEvent): string | null {
  if ("turn" in event) return event.turn.id;
  if ("response" in event) return event.response.turnId;
  if ("block" in event) return event.block.turnId;
  if ("turnId" in event) return event.turnId ?? null;
  return null;
}
